import { type Fetcher, HttpSession } from "../../http/session.ts";
import { createProviderConnection, type ProviderConnection } from "../../model/connection.ts";

export const YUCHO_DEBIT_PROVIDER_ID = "yucho-debit" as const;
export const DEFAULT_BASE_URL = "https://www.debit.vpass.ne.jp";
export const CARD_COMPANY_CODE = "01010";

export type YuchoDebitAuthenticationState =
  | "empty"
  | "restored"
  | "valid"
  | "expired";

export interface YuchoDebitContext {
  readonly connection: ProviderConnection<typeof YUCHO_DEBIT_PROVIDER_ID>;
  readonly session: HttpSession;
  readonly baseURL: URL;
  authenticationState: YuchoDebitAuthenticationState;
  userAgent: string;
}

export interface YuchoDebitContextConfig {
  readonly connection?: ProviderConnection<typeof YUCHO_DEBIT_PROVIDER_ID>;
  readonly baseURL?: string;
  readonly fetch?: Fetcher;
}

export function createYuchoDebitContext(
  config: YuchoDebitContextConfig = {},
): YuchoDebitContext {
  return {
    connection: config.connection ??
      createProviderConnection(YUCHO_DEBIT_PROVIDER_ID, "default"),
    session: new HttpSession(config.fetch),
    baseURL: parseBaseURL(config.baseURL ?? DEFAULT_BASE_URL),
    authenticationState: "empty",
    userAgent: "",
  };
}

export function resolveYuchoDebitPath(context: YuchoDebitContext, path: string): URL {
  const result = new URL(context.baseURL);
  result.pathname = `${context.baseURL.pathname.replace(/\/$/, "")}${path}`;
  result.search = "";
  result.hash = "";
  return result;
}

function parseBaseURL(value: string): URL {
  const result = new URL(value);
  if (
    (result.protocol !== "https:" && result.protocol !== "http:") ||
    result.username !== "" || result.password !== "" || result.search !== "" ||
    result.hash !== ""
  ) {
    throw new TypeError(
      "yucho-debit: base URL must contain only an HTTP(S) scheme, host, and optional path",
    );
  }
  result.pathname = result.pathname.replace(/\/+$/, "");
  return result;
}
