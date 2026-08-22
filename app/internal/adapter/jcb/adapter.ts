import type { WalletID } from "../../model/account.ts";
import { readBytesLimited } from "../../http/body.ts";
import type { CashOut } from "../../model/transaction.ts";
import type { CashOutSource, FetchOptions, Period } from "../../port/source.ts";
import { JCBError, UnauthenticatedError, UnexpectedPageError } from "./errors.ts";
import { type Credentials, type LoginOptions, MYPAGE_PATH, performLogin } from "./login.ts";
import { parseStatement, statementRowToCashOut, statementSequences } from "./parser.ts";
import { type Fetcher, HttpSession } from "./session.ts";

export const DEFAULT_BASE_URL = "https://my.jcb.co.jp";
export const DETAIL_PATH = "/iss-pc/member/debit/details/debitDetail.html";
export const DETAIL_MENU_PATH = "/iss-pc/member/debit/details/debitDetailMenu.html";
export const DETAIL_MENU_LINK_ID = "myj_main_debitDetailMenu";
export const MAX_RESPONSE_BYTES = 4 << 20;

export interface Config {
  walletID: WalletID;
  baseURL?: string;
  fetch?: Fetcher;
  now?: () => Date;
}

export class JCBAdapter implements CashOutSource {
  readonly session: HttpSession;
  readonly walletID: WalletID;
  readonly baseURL: URL;
  readonly now: () => Date;
  userAgent = "";

  constructor(config: Config) {
    if (config.walletID.trim() === "") throw new TypeError("jcb: wallet ID is required");
    const base = new URL(config.baseURL ?? DEFAULT_BASE_URL);
    if (
      (base.protocol !== "http:" && base.protocol !== "https:") || base.search !== "" ||
      base.hash !== ""
    ) {
      throw new TypeError(
        "jcb: base URL must contain only an HTTP(S) scheme, host, and optional path",
      );
    }
    base.pathname = base.pathname.replace(/\/+$/, "");
    this.session = new HttpSession(config.fetch);
    this.walletID = config.walletID;
    this.baseURL = base;
    this.now = config.now ?? (() => new Date());
  }

  async login(credentials: Credentials, options: LoginOptions = {}): Promise<void> {
    await performLogin(this, credentials, options);
  }

  async fetchCashOuts(period: Period, options: FetchOptions = {}): Promise<CashOut[]> {
    const sequences = statementSequences(period, this.now());
    if (sequences.length === 0) return [];
    try {
      await this.#openStatementMenu(options.signal);
    } catch (error) {
      throw new JCBError(`open statement menu: ${errorMessage(error)}`, { cause: error });
    }
    const cashOuts: CashOut[] = [];
    for (const sequence of sequences) {
      let rows;
      try {
        rows = await this.#fetchStatement(sequence, options.signal);
      } catch (error) {
        throw new JCBError(`fetch statement sequence ${sequence}: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      for (const row of rows) {
        if (
          row.occurredAt.getTime() < period.from.getTime() ||
          row.occurredAt.getTime() >= period.to.getTime()
        ) {
          continue;
        }
        cashOuts.push(statementRowToCashOut(row, this.walletID));
      }
    }
    cashOuts.sort((left, right) =>
      left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id)
    );
    return cashOuts;
  }

  resolvePath(path: string): URL {
    const result = new URL(this.baseURL);
    result.pathname = `${this.baseURL.pathname.replace(/\/$/, "")}${path}`;
    result.search = "";
    result.hash = "";
    return result;
  }

  async #fetchStatement(sequence: number, signal?: AbortSignal) {
    const detailURL = this.resolvePath(DETAIL_PATH);
    detailURL.searchParams.set("seq", String(sequence));
    const headers = new Headers({
      Accept: "text/html,application/xhtml+xml",
      Referer: this.#statementMenuURL().href,
    });
    if (this.userAgent !== "") headers.set("User-Agent", this.userAgent);

    const response = await this.session.request(detailURL, { headers, signal });
    if (isLoginResponse(response)) throw new UnauthenticatedError();
    if (response.status !== 200) throw new JCBError(`unexpected HTTP status ${response.status}`);
    const html = await decodeLimitedResponse(response, MAX_RESPONSE_BYTES);
    const parsed = parseStatement(html);
    if (!parsed.found) throw new UnexpectedPageError();
    return parsed.rows;
  }

  async #openStatementMenu(signal?: AbortSignal): Promise<void> {
    const menuURL = this.#statementMenuURL();
    const headers = new Headers({
      Accept: "text/html,application/xhtml+xml",
      Referer: this.resolvePath(MYPAGE_PATH).href,
    });
    if (this.userAgent !== "") headers.set("User-Agent", this.userAgent);

    const response = await this.session.request(menuURL, { headers, signal });
    if (isLoginResponse(response)) throw new UnauthenticatedError();
    if (response.status !== 200) throw new JCBError(`unexpected HTTP status ${response.status}`);
    await decodeLimitedResponse(response, MAX_RESPONSE_BYTES);
  }

  #statementMenuURL(): URL {
    const menuURL = this.resolvePath(DETAIL_MENU_PATH);
    menuURL.searchParams.set("link_id", DETAIL_MENU_LINK_ID);
    return menuURL;
  }
}

export function isLoginResponse(response: Response): boolean {
  if (response.status === 401 || response.status === 403) return true;
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

async function decodeLimitedResponse(response: Response, limit: number): Promise<string> {
  const bytes = await readBytesLimited(
    response,
    limit,
    (value) => new JCBError(`response exceeds ${value} bytes`),
  );
  const contentType = response.headers.get("Content-Type") ?? "";
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch (error) {
    throw new JCBError(`decode response as ${charset}`, { cause: error });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
