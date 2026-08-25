import type { Wallet } from "../../model/account.ts";
import { rethrowAbort } from "../../error/abort.ts";
import type { CashIn, CashOut } from "../../model/transaction.ts";
import type { CashFlowSource, FetchOptions, Period } from "../../port/source.ts";
import { JCBError, UnauthenticatedError, UnexpectedPageError } from "./errors.ts";
import { readJCBHTML } from "./html.ts";
import { MYPAGE_PATH } from "./login.ts";
import {
  isCompletedStatementRow,
  parseStatement,
  statementRowToCashIn,
  statementRowToCashOut,
  statementSequences,
} from "./parser.ts";
import { DEFAULT_BASE_URL, type JCBContext, resolveJCBPath } from "./context.ts";

export const DETAIL_PATH = "/iss-pc/member/debit/details/debitDetail.html";
export const DETAIL_MENU_PATH = "/iss-pc/member/debit/details/debitDetailMenu.html";
export const DETAIL_MENU_LINK_ID = "myj_main_debitDetailMenu";

export interface Config {
  readonly wallet: Wallet;
  readonly now?: () => Date;
}

export class JCBAdapter implements CashFlowSource {
  readonly #context: JCBContext;
  readonly wallet: Wallet;
  readonly now: () => Date;

  constructor(context: JCBContext, config: Config) {
    if (config.wallet.id.trim() === "") throw new TypeError("jcb: wallet ID is required");
    if (config.wallet.connectionID !== context.connection.id) {
      throw new TypeError("jcb: wallet belongs to another connection");
    }
    this.#context = context;
    this.wallet = config.wallet;
    this.now = config.now ?? (() => new Date());
  }

  async fetchCashFlows(
    period: Period,
    options: FetchOptions = {},
  ): Promise<{ readonly cashIns: CashIn[]; readonly cashOuts: CashOut[] }> {
    if (this.#context.authenticationState !== "valid") throw new UnauthenticatedError();
    const sequences = statementSequences(period, this.now());
    if (sequences.length === 0) return { cashIns: [], cashOuts: [] };
    try {
      await this.#openStatementMenu(options.signal);
    } catch (error) {
      rethrowAbort(error, options.signal);
      if (error instanceof UnauthenticatedError) throw error;
      throw new JCBError(`open statement menu: ${errorMessage(error)}`, { cause: error });
    }
    const cashIns = new Map<string, CashIn>();
    const cashOuts = new Map<string, CashOut>();
    for (const sequence of sequences) {
      let rows;
      try {
        rows = await this.#fetchStatement(sequence, options.signal);
      } catch (error) {
        rethrowAbort(error, options.signal);
        if (error instanceof UnauthenticatedError) throw error;
        throw new JCBError(`fetch statement sequence ${sequence}: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      for (const row of rows) {
        if (
          !isCompletedStatementRow(row) ||
          row.occurredAt.getTime() < period.from.getTime() ||
          row.occurredAt.getTime() >= period.to.getTime()
        ) {
          continue;
        }
        if (row.amount < 0) {
          const cashIn = statementRowToCashIn(row, this.wallet);
          cashIns.set(cashIn.id, cashIn);
        } else {
          const cashOut = statementRowToCashOut(row, this.wallet);
          cashOuts.set(cashOut.id, cashOut);
        }
      }
    }
    return {
      cashIns: sortedTransactions(cashIns.values()),
      cashOuts: sortedTransactions(cashOuts.values()),
    };
  }

  async #fetchStatement(sequence: number, signal?: AbortSignal) {
    const detailURL = resolveJCBPath(this.#context, DETAIL_PATH);
    detailURL.searchParams.set("seq", String(sequence));
    const headers = new Headers({
      Accept: "text/html,application/xhtml+xml",
      Referer: this.#statementMenuURL().href,
    });
    if (this.#context.userAgent !== "") headers.set("User-Agent", this.#context.userAgent);

    const response = await this.#context.session.request(detailURL, { headers, signal });
    if (isLoginResponse(response)) this.#authenticationRequired();
    if (response.status !== 200) throw new JCBError(`unexpected HTTP status ${response.status}`);
    const html = await readJCBHTML(response);
    const parsed = parseStatement(html);
    if (!parsed.found) throw new UnexpectedPageError();
    return parsed.rows;
  }

  async #openStatementMenu(signal?: AbortSignal): Promise<void> {
    const menuURL = this.#statementMenuURL();
    const headers = new Headers({
      Accept: "text/html,application/xhtml+xml",
      Referer: resolveJCBPath(this.#context, MYPAGE_PATH).href,
    });
    if (this.#context.userAgent !== "") headers.set("User-Agent", this.#context.userAgent);

    const response = await this.#context.session.request(menuURL, { headers, signal });
    if (isLoginResponse(response)) this.#authenticationRequired();
    if (response.status !== 200) throw new JCBError(`unexpected HTTP status ${response.status}`);
    await readJCBHTML(response);
  }

  #statementMenuURL(): URL {
    const menuURL = resolveJCBPath(this.#context, DETAIL_MENU_PATH);
    menuURL.searchParams.set("link_id", DETAIL_MENU_LINK_ID);
    return menuURL;
  }

  #authenticationRequired(): never {
    this.#context.authenticationState = "expired";
    throw new UnauthenticatedError();
  }
}

function sortedTransactions<Transaction extends CashIn | CashOut>(
  values: Iterable<Transaction>,
): Transaction[] {
  return [...values].sort((left, right) =>
    left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id)
  );
}

export function isLoginResponse(response: Response): boolean {
  if (response.status === 401) return true;
  const path = response.url === ""
    ? ""
    : new URL(response.url).pathname.toLowerCase().replace(/\/+$/, "");
  if (path === "/login" || path.includes("/user_manage/login")) return true;
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (location !== null) {
      const redirectedPath = new URL(location, response.url || DEFAULT_BASE_URL).pathname
        .toLowerCase().replace(/\/+$/, "");
      return redirectedPath === "/login" || redirectedPath.includes("/user_manage/login");
    }
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
