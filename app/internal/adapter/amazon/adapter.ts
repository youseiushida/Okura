import { readTextLimited } from "../../http/body.ts";
import type { WalletID } from "../../model/account.ts";
import type { CashOut } from "../../model/transaction.ts";
import type { CashOutSource, FetchOptions, Period } from "../../port/source.ts";
import { AmazonError, UnauthenticatedError, UnexpectedPageError } from "./errors.ts";
import type { AmazonContext } from "./context.ts";
import {
  type AmazonOrderReference,
  isEmptyOrderPage,
  orderToCashOut,
  parseOrderDetail,
  parseOrderPage,
} from "./parser.ts";
import { AMAZON_USER_AGENT } from "./runtime.ts";

export const ORDERS_PATH = "/your-orders/orders";
export const MAX_RESPONSE_BYTES = 4 << 20;
const PAGE_SIZE = 10;
const MAX_PAGES_PER_YEAR = 200;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface Config {
  readonly walletID: WalletID;
  readonly pageDelayMs?: number;
}

export class AmazonAdapter implements CashOutSource {
  readonly #context: AmazonContext;
  readonly walletID: WalletID;
  readonly pageDelayMs: number;

  constructor(context: AmazonContext, config: Config) {
    if (config.walletID.trim() === "") throw new TypeError("amazon: wallet ID is required");
    this.#context = context;
    this.walletID = config.walletID;
    this.pageDelayMs = config.pageDelayMs ?? 250;
  }

  async fetchCashOuts(period: Period, options: FetchOptions = {}): Promise<CashOut[]> {
    validatePeriod(period);
    if (period.from.getTime() === period.to.getTime()) return [];
    if (this.#context.authenticationState !== "valid") throw new UnauthenticatedError();

    const orders = new Map<string, CashOut>();
    for (const year of yearsForPeriod(period)) {
      try {
        await this.#fetchYear(year, period, orders, options.signal);
      } catch (error) {
        if (error instanceof AmazonError) throw error;
        throw new AmazonError(`fetch Amazon orders for ${year}: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    }
    return [...orders.values()].sort((left, right) =>
      left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id)
    );
  }

  async #fetchYear(
    year: number,
    period: Period,
    result: Map<string, CashOut>,
    signal?: AbortSignal,
  ): Promise<void> {
    for (let page = 0; page < MAX_PAGES_PER_YEAR; page += 1) {
      signal?.throwIfAborted();
      const startIndex = page * PAGE_SIZE;
      const url = new URL(ORDERS_PATH, this.#context.baseURL);
      if (page === 0) {
        url.searchParams.set("orderFilter", "all");
      } else {
        url.searchParams.set("startIndex", String(startIndex));
        url.searchParams.set("orderFilter", "UNIFIED");
        url.searchParams.set("enablePosy", "false");
      }
      url.searchParams.set("timeFilter", `year-${year}`);
      const response = await this.#context.session.request(url, {
        headers: orderHeaders(this.#context.baseURL.href, page === 0),
        signal,
      });
      if (isAuthenticationResponse(response)) throw new UnauthenticatedError();
      if (response.status !== 200) {
        throw new AmazonError(`unexpected HTTP status ${response.status}`);
      }
      const payload = await decodeLimitedResponse(response, MAX_RESPONSE_BYTES);
      const parsed = parseOrderPage(payload);
      if (parsed.cardCount === 0) {
        if (isEmptyOrderPage(payload) || page > 0) return;
        throw new UnexpectedPageError("Amazon order page did not contain recognizable orders");
      }
      if (parsed.cardCount > 0 && parsed.orders.length === 0 && parsed.references.length === 0) {
        throw new UnexpectedPageError("Amazon order cards could not be parsed");
      }
      for (const order of parsed.orders) {
        if (order.canceled || order.amount <= 0) continue;
        if (
          order.occurredAt.getTime() < period.from.getTime() ||
          order.occurredAt.getTime() >= period.to.getTime()
        ) continue;
        const cashOut = orderToCashOut(order, this.walletID);
        result.set(cashOut.id, cashOut);
      }
      for (let index = 0; index < parsed.references.length; index += 1) {
        const reference = parsed.references[index]!;
        if (reference.canceled || result.has(`amazon:${reference.id}`)) continue;
        if (
          reference.occurredAt !== undefined &&
          (reference.occurredAt.getTime() < period.from.getTime() ||
            reference.occurredAt.getTime() >= period.to.getTime())
        ) continue;
        const detail = await this.#fetchOrderDetail(
          reference,
          page * PAGE_SIZE + index + 1,
          url.href,
          signal,
        );
        const occurredAt = reference.occurredAt ?? detail.occurredAt;
        if (occurredAt === undefined) {
          throw new UnexpectedPageError(
            `Amazon order detail ${page * PAGE_SIZE + index + 1} did not contain an order date`,
          );
        }
        if (
          occurredAt.getTime() < period.from.getTime() ||
          occurredAt.getTime() >= period.to.getTime() || detail.amount <= 0
        ) continue;
        const cashOut = orderToCashOut(
          { ...reference, occurredAt, amount: detail.amount },
          this.walletID,
        );
        result.set(cashOut.id, cashOut);
        await delay(this.pageDelayMs, signal);
      }
      if (parsed.cardCount < PAGE_SIZE) return;
      await delay(this.pageDelayMs, signal);
    }
    throw new UnexpectedPageError(`Amazon pagination exceeded ${MAX_PAGES_PER_YEAR} pages`);
  }

  async #fetchOrderDetail(
    reference: AmazonOrderReference,
    sequence: number,
    referer: string,
    signal?: AbortSignal,
  ): Promise<{ amount: number; occurredAt?: Date }> {
    const url = new URL(reference.detailPath, this.#context.baseURL);
    if (url.origin !== this.#context.baseURL.origin) {
      throw new UnexpectedPageError("Amazon order detail URL has an unexpected origin");
    }
    const response = await this.#context.session.request(url, {
      headers: detailHeaders(referer),
      signal,
    });
    if (isAuthenticationResponse(response)) throw new UnauthenticatedError();
    if (response.status !== 200) {
      throw new AmazonError(`unexpected order detail HTTP status ${response.status}`);
    }
    const payload = await decodeLimitedResponse(response, MAX_RESPONSE_BYTES);
    const detail = parseOrderDetail(payload);
    if (detail.amount === undefined) {
      throw new UnexpectedPageError(
        `Amazon order detail ${sequence} did not contain a recognizable total`,
      );
    }
    return { ...detail, amount: detail.amount };
  }
}

function yearsForPeriod(period: Period): number[] {
  const fromYear = jstYear(period.from);
  const toYear = jstYear(new Date(period.to.getTime() - 1));
  const result: number[] = [];
  for (let year = fromYear; year <= toYear; year += 1) result.push(year);
  return result;
}

function jstYear(value: Date): number {
  return new Date(value.getTime() + JST_OFFSET_MS).getUTCFullYear();
}

function validatePeriod(period: Period): void {
  if (!(period.from instanceof Date) || Number.isNaN(period.from.getTime())) {
    throw new TypeError("amazon: period start is required");
  }
  if (!(period.to instanceof Date) || Number.isNaN(period.to.getTime())) {
    throw new TypeError("amazon: period end is required");
  }
  if (period.from.getTime() > period.to.getTime()) {
    throw new TypeError("amazon: period start must not be after its end");
  }
}

function orderHeaders(referer: string, navigation: boolean): Headers {
  return new Headers({
    Accept: navigation
      ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      : "application/json",
    "Accept-Language": "ja,en;q=0.9,en-US;q=0.8",
    Referer: referer,
    "User-Agent": AMAZON_USER_AGENT,
  });
}

function detailHeaders(referer: string): Headers {
  return new Headers({
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en;q=0.9,en-US;q=0.8",
    Referer: referer,
    "User-Agent": AMAZON_USER_AGENT,
  });
}

function isAuthenticationResponse(response: Response): boolean {
  if (response.status === 401 || response.status === 403) return true;
  const path = response.url === "" ? "" : new URL(response.url).pathname;
  return path === "/ap/signin" || path === "/ax/claim" || path.startsWith("/ap/cvf/");
}

async function decodeLimitedResponse(response: Response, limit: number): Promise<string> {
  return await readTextLimited(
    response,
    limit,
    (value) => new UnexpectedPageError(`Amazon response exceeds ${value} bytes`),
  );
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  signal?.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, milliseconds);
      onAbort = () => {
        clearTimeout(timeout);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
