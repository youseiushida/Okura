import { readTextLimited } from "../../http/body.ts";
import { rethrowAbort } from "../../error/abort.ts";
import type { AssetBalance } from "../../model/asset.ts";
import type { CashIn, CashOut, Transfer } from "../../model/transaction.ts";
import type {
  AssetBalanceSource,
  CashInSource,
  CashOutSource,
  FetchOptions,
  Period,
  TransferSource,
} from "../../port/source.ts";
import type { MoneyForwardContext } from "./context.ts";
import { MoneyForwardError, UnauthenticatedError, UnexpectedPageError } from "./errors.ts";
import {
  cashFlowToCashIn,
  cashFlowToCashOut,
  extractCashFlowHTML,
  parseAssetBalances,
  type ParsedCashFlow,
  type ParsedMoneyForwardTransaction,
  type ParsedTransfer,
  parsedTransferToTransfer,
  parseMoneyForwardTransactions,
} from "./parser.ts";

export const PORTFOLIO_PATH = "/bs/portfolio";
export const CASH_FLOW_PATH = "/cf";
export const CASH_FLOW_FETCH_PATH = "/cf/fetch";
export const MAX_RESPONSE_BYTES = 8 << 20;
export const MONEYFORWARD_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface Config {
  readonly now?: () => Date;
}

export class MoneyForwardAdapter
  implements AssetBalanceSource, CashInSource, CashOutSource, TransferSource {
  readonly #context: MoneyForwardContext;
  readonly #now: () => Date;
  #cache?: {
    readonly key: string;
    readonly value: Promise<ParsedMoneyForwardTransaction[]>;
  };

  constructor(context: MoneyForwardContext, config: Config = {}) {
    this.#context = context;
    this.#now = config.now ?? (() => new Date());
  }

  async fetchAssetBalances(options: FetchOptions = {}): Promise<AssetBalance[]> {
    this.#assertAuthenticated();
    const url = new URL(PORTFOLIO_PATH, this.#context.baseURL);
    const response = await this.#context.session.request(url, {
      headers: navigationHeaders(new URL("/", this.#context.baseURL).href),
      signal: options.signal,
    });
    if (isAuthenticationResponse(response, this.#context)) this.#authenticationRequired();
    if (
      response.status !== 200 || !isExpectedURL(response, this.#context.baseURL, PORTFOLIO_PATH)
    ) {
      throw new UnexpectedPageError(
        `Money Forward portfolio returned an unexpected response (HTTP ${response.status})`,
      );
    }
    const html = await decodeLimited(response);
    return parseAssetBalances(html, this.#now(), this.#context.connection);
  }

  async fetchCashIns(period: Period, options: FetchOptions = {}): Promise<CashIn[]> {
    const values = await this.#cashFlows(period, options);
    return values.filter((value): value is ParsedCashFlow =>
      value.kind === "income" && value.target
    ).map(cashFlowToCashIn);
  }

  async fetchCashOuts(period: Period, options: FetchOptions = {}): Promise<CashOut[]> {
    const values = await this.#cashFlows(period, options);
    return values.filter((value): value is ParsedCashFlow =>
      value.kind === "expense" && value.target
    ).map(cashFlowToCashOut);
  }

  async fetchTransfers(period: Period, options: FetchOptions = {}): Promise<Transfer[]> {
    const values = await this.#cashFlows(period, options);
    return values.filter((value): value is ParsedTransfer => value.kind === "transfer")
      .map(parsedTransferToTransfer);
  }

  async #cashFlows(
    period: Period,
    options: FetchOptions,
  ): Promise<ParsedMoneyForwardTransaction[]> {
    validatePeriod(period);
    this.#assertAuthenticated();
    if (period.from.getTime() === period.to.getTime()) return [];
    const key = `${period.from.toISOString()}\n${period.to.toISOString()}`;
    if (options.signal !== undefined) return await this.#fetchCashFlows(period, options.signal);
    if (this.#cache?.key === key) return await this.#cache.value;
    const value = this.#fetchCashFlows(period);
    this.#cache = { key, value };
    try {
      return await value;
    } finally {
      if (this.#cache?.value === value) this.#cache = undefined;
    }
  }

  async #fetchCashFlows(
    period: Period,
    signal?: AbortSignal,
  ): Promise<ParsedMoneyForwardTransaction[]> {
    try {
      const pageURL = new URL(CASH_FLOW_PATH, this.#context.baseURL);
      const pageResponse = await this.#context.session.request(pageURL, {
        headers: navigationHeaders(new URL("/", this.#context.baseURL).href),
        signal,
      });
      if (isAuthenticationResponse(pageResponse, this.#context)) this.#authenticationRequired();
      if (
        pageResponse.status !== 200 ||
        !isExpectedURL(pageResponse, this.#context.baseURL, CASH_FLOW_PATH)
      ) {
        throw new UnexpectedPageError(
          `Money Forward cash-flow page returned an unexpected response (HTTP ${pageResponse.status})`,
        );
      }
      const pageHTML = await decodeLimited(pageResponse);
      if (!isCashFlowPage(pageHTML)) {
        throw new UnexpectedPageError("Money Forward cash-flow page was not recognizable");
      }
      const csrfToken = extractCSRFToken(pageHTML);
      const result = new Map<string, ParsedMoneyForwardTransaction>();
      for (const month of monthsForPeriod(period)) {
        signal?.throwIfAborted();
        const response = await this.#context.session.request(
          new URL(CASH_FLOW_FETCH_PATH, this.#context.baseURL),
          {
            method: "POST",
            headers: cashFlowHeaders(pageURL.href, csrfToken),
            body: new URLSearchParams({
              from: formatFetchMonth(month),
              service_id: "",
              account_id_hash: "",
            }),
            signal,
          },
        );
        if (isAuthenticationResponse(response, this.#context)) this.#authenticationRequired();
        if (
          response.status !== 200 ||
          !isExpectedURL(response, this.#context.baseURL, CASH_FLOW_FETCH_PATH)
        ) {
          throw new UnexpectedPageError(
            `Money Forward cash-flow fetch returned an unexpected response (HTTP ${response.status})`,
          );
        }
        const javascript = await decodeLimited(response);
        for (
          const flow of parseMoneyForwardTransactions(
            extractCashFlowHTML(javascript),
            month,
            this.#context.connection,
          )
        ) {
          if (
            flow.occurredAt.getTime() < period.from.getTime() ||
            flow.occurredAt.getTime() >= period.to.getTime()
          ) continue;
          result.set(flow.id, flow);
        }
      }
      return [...result.values()].sort((left, right) =>
        left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id)
      );
    } catch (error) {
      rethrowAbort(error, signal);
      if (error instanceof UnauthenticatedError) throw error;
      if (error instanceof MoneyForwardError) throw error;
      throw new MoneyForwardError(`fetch Money Forward cash flows: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  #assertAuthenticated(): void {
    if (this.#context.authenticationState !== "valid") throw new UnauthenticatedError();
  }

  #authenticationRequired(): never {
    this.#context.authenticationState = "expired";
    throw new UnauthenticatedError();
  }
}

export function isCashFlowPage(html: string): boolean {
  return /\bcf_controller\b|action=["'][^"']*\/cf\/create(?:[?#"'])/i.test(html);
}

export function extractCSRFToken(html: string): string {
  const match = html.match(
    /<meta\b(?=[^>]*\bname=["']csrf-token["'])[^>]*\bcontent=["']([^"']+)["'][^>]*>/i,
  ) ?? html.match(
    /<meta\b(?=[^>]*\bcontent=["']([^"']+)["'])[^>]*\bname=["']csrf-token["'][^>]*>/i,
  );
  const value = match?.[1]?.replaceAll("&amp;", "&") ?? "";
  if (value === "") throw new UnexpectedPageError("Money Forward CSRF token was not found");
  return value;
}

function monthsForPeriod(period: Period): Date[] {
  const first = jstMonthStart(period.from);
  const lastInstant = new Date(period.to.getTime() - 1);
  const last = jstMonthStart(lastInstant);
  const result: Date[] = [];
  for (let current = first; current.getTime() <= last.getTime(); current = nextJSTMonth(current)) {
    result.push(current);
  }
  return result;
}

function jstMonthStart(value: Date): Date {
  const shifted = new Date(value.getTime() + JST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - JST_OFFSET_MS);
}

function nextJSTMonth(value: Date): Date {
  const shifted = new Date(value.getTime() + JST_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - JST_OFFSET_MS,
  );
}

function formatFetchMonth(value: Date): string {
  const shifted = new Date(value.getTime() + JST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}/${shifted.getUTCMonth() + 1}/1`;
}

function validatePeriod(period: Period): void {
  if (!(period.from instanceof Date) || Number.isNaN(period.from.getTime())) {
    throw new TypeError("moneyforward: period start is required");
  }
  if (!(period.to instanceof Date) || Number.isNaN(period.to.getTime())) {
    throw new TypeError("moneyforward: period end is required");
  }
  if (period.from.getTime() > period.to.getTime()) {
    throw new TypeError("moneyforward: period start must not be after its end");
  }
}

function navigationHeaders(referer: string): Headers {
  return new Headers({
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en;q=0.9,en-US;q=0.8",
    Referer: referer,
    "User-Agent": MONEYFORWARD_USER_AGENT,
  });
}

function cashFlowHeaders(referer: string, csrfToken: string): Headers {
  return new Headers({
    Accept: "text/javascript, application/javascript, application/ecmascript, */*; q=0.01",
    "Accept-Language": "ja,en;q=0.9,en-US;q=0.8",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: new URL(referer).origin,
    Referer: referer,
    "User-Agent": MONEYFORWARD_USER_AGENT,
    "X-CSRF-Token": csrfToken,
    "X-Requested-With": "XMLHttpRequest",
  });
}

function isAuthenticationResponse(response: Response, context: MoneyForwardContext): boolean {
  if (response.status === 401) return true;
  if (response.url === "") return false;
  const url = new URL(response.url);
  return url.origin === context.idBaseURL.origin ||
    (url.origin === context.baseURL.origin &&
      (url.pathname === "/sign_in" || url.pathname.startsWith("/auth/mfid")));
}

function isExpectedURL(response: Response, baseURL: URL, pathname: string): boolean {
  if (response.url === "") return false;
  const url = new URL(response.url);
  return url.origin === baseURL.origin && url.pathname === pathname;
}

async function decodeLimited(response: Response): Promise<string> {
  return await readTextLimited(
    response,
    MAX_RESPONSE_BYTES,
    (value) => new UnexpectedPageError(`Money Forward response exceeds ${value} bytes`),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
