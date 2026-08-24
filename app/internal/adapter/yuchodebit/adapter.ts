import { rethrowAbort } from "../../error/abort.ts";
import type { Wallet } from "../../model/account.ts";
import type { CashOut } from "../../model/transaction.ts";
import type { CashOutSource, FetchOptions, Period } from "../../port/source.ts";
import { CARD_COMPANY_CODE, resolveYuchoDebitPath, type YuchoDebitContext } from "./context.ts";
import {
  PeriodUnavailableError,
  UnauthenticatedError,
  UnexpectedPageError,
  YuchoDebitError,
} from "./errors.ts";
import { assertResponseOrigin, formHeaders, limitedHTML, navigationHeaders } from "./login.ts";
import {
  parseNavigationSubmission,
  parsePageStatus,
  parseStatementMonths,
  parseStatementPage,
  statementMonthStart,
  submissionBody,
} from "./parser.ts";
import { HOME_PATH, LOGIN_PATH, STATEMENT_INDEX_PATH } from "./routes.ts";

const MAX_PAGES_PER_MONTH = 20;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface Config {
  readonly wallet: Wallet;
}

export class YuchoDebitAdapter implements CashOutSource {
  readonly #context: YuchoDebitContext;
  readonly wallet: Wallet;

  constructor(context: YuchoDebitContext, config: Config) {
    if (config.wallet.id.trim() === "") throw new TypeError("yucho-debit: wallet ID is required");
    if (config.wallet.connectionID !== context.connection.id) {
      throw new TypeError("yucho-debit: wallet belongs to another connection");
    }
    this.#context = context;
    this.wallet = config.wallet;
  }

  async fetchCashOuts(period: Period, options: FetchOptions = {}): Promise<CashOut[]> {
    validatePeriod(period);
    if (period.from.getTime() === period.to.getTime()) return [];
    if (this.#context.authenticationState !== "valid") throw new UnauthenticatedError();
    try {
      const home = await this.#openHome(options.signal);
      const indexSubmission = parseNavigationSubmission(
        home.html,
        home.url,
        STATEMENT_INDEX_PATH,
      );
      const index = await this.#post(
        indexSubmission.action,
        submissionBody(indexSubmission),
        home.url,
        options.signal,
      );
      this.#assertAuthenticated(index.html);
      const months = parseStatementMonths(index.html, index.url);
      const oldest = months.reduce((left, right) =>
        statementMonthStart(left).getTime() <= statementMonthStart(right).getTime() ? left : right
      );
      const availableFrom = statementMonthStart(oldest);
      if (period.from.getTime() < availableFrom.getTime()) {
        throw new PeriodUnavailableError(availableFrom);
      }
      const selected = months.filter((month) => {
        const start = statementMonthStart(month);
        const end = addJSTMonth(start);
        return start.getTime() < period.to.getTime() && period.from.getTime() < end.getTime();
      }).sort((left, right) =>
        statementMonthStart(left).getTime() - statementMonthStart(right).getTime()
      );

      const result = new Map<string, CashOut>();
      for (const month of selected) {
        const first = await this.#post(
          month.submission.action,
          submissionBody(month.submission, {
            "W131301.referenceDate": month.referenceDate,
          }),
          index.url,
          options.signal,
        );
        this.#assertAuthenticated(first.html);
        await this.#collectMonth(first, period, result, options.signal);
      }
      return [...result.values()].sort((left, right) =>
        left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id)
      );
    } catch (error) {
      rethrowAbort(error, options.signal);
      if (
        error instanceof UnauthenticatedError || error instanceof PeriodUnavailableError ||
        error instanceof UnexpectedPageError || error instanceof YuchoDebitError
      ) throw error;
      throw new YuchoDebitError(`fetch statements: ${errorMessage(error)}`, { cause: error });
    }
  }

  async #collectMonth(
    first: PageResponse,
    period: Period,
    result: Map<string, CashOut>,
    signal?: AbortSignal,
  ): Promise<void> {
    let response = first;
    let expectedCount: number | undefined;
    for (let pageNumber = 1; pageNumber <= MAX_PAGES_PER_MONTH; pageNumber += 1) {
      signal?.throwIfAborted();
      const page = parseStatementPage(response.html, response.url, this.wallet);
      if (page.currentPage !== pageNumber) {
        throw new UnexpectedPageError("statement pagination did not advance sequentially");
      }
      if (expectedCount === undefined) expectedCount = page.resultCount;
      if (page.resultCount !== expectedCount) {
        throw new UnexpectedPageError("statement result count changed during pagination");
      }
      for (const cashOut of page.cashOuts) {
        if (
          cashOut.occurredAt.getTime() >= period.from.getTime() &&
          cashOut.occurredAt.getTime() < period.to.getTime()
        ) result.set(cashOut.id, cashOut);
      }
      if (page.next === undefined) return;
      response = await this.#post(
        page.next.action,
        submissionBody(page.next),
        response.url,
        signal,
      );
      this.#assertAuthenticated(response.html);
    }
    throw new UnexpectedPageError(
      `statement pagination exceeded ${MAX_PAGES_PER_MONTH} pages`,
    );
  }

  async #openHome(signal?: AbortSignal): Promise<PageResponse> {
    const url = resolveYuchoDebitPath(this.#context, HOME_PATH);
    url.searchParams.set("cc", CARD_COMPANY_CODE);
    const response = await this.#context.session.request(url, {
      headers: navigationHeaders(this.#context.baseURL.href, this.#context.userAgent),
      signal,
    });
    assertResponseOrigin(
      this.#context,
      response,
      [HOME_PATH, LOGIN_PATH],
      "open home page",
    );
    const html = await limitedHTML(response, "open home page");
    const result = { html, url: response.url || url.href };
    this.#assertAuthenticated(html);
    return result;
  }

  async #post(
    action: string,
    body: URLSearchParams,
    referer: string,
    signal?: AbortSignal,
  ): Promise<PageResponse> {
    const url = new URL(action);
    if (url.origin !== this.#context.baseURL.origin) {
      throw new UnexpectedPageError("statement form action is cross-origin");
    }
    const response = await this.#context.session.request(url, {
      method: "POST",
      signal,
      headers: formHeaders(this.#context, referer, this.#context.userAgent),
      body,
    });
    const expectedPath = url.pathname.replace(/;[^/]*$/, "");
    assertResponseOrigin(
      this.#context,
      response,
      [expectedPath, HOME_PATH, LOGIN_PATH],
      "fetch statement page",
    );
    return {
      html: await limitedHTML(response, "fetch statement page"),
      url: response.url || url.href,
    };
  }

  #assertAuthenticated(html: string): void {
    const status = parsePageStatus(html);
    if (status === "authenticated") return;
    if (status === "expired") {
      this.#context.authenticationState = "expired";
      throw new UnauthenticatedError();
    }
    throw new UnexpectedPageError("provider returned an unrecognized authenticated page");
  }
}

interface PageResponse {
  readonly html: string;
  readonly url: string;
}

function validatePeriod(period: Period): void {
  if (!(period.from instanceof Date) || Number.isNaN(period.from.getTime())) {
    throw new TypeError("yucho-debit: period start is invalid");
  }
  if (!(period.to instanceof Date) || Number.isNaN(period.to.getTime())) {
    throw new TypeError("yucho-debit: period end is invalid");
  }
  if (period.from.getTime() > period.to.getTime()) {
    throw new TypeError("yucho-debit: period start must not be after its end");
  }
}

function addJSTMonth(value: Date): Date {
  const shifted = new Date(value.getTime() + JST_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - JST_OFFSET_MS,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
