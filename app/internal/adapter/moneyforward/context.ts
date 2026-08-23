import { type Fetcher, HttpSession } from "../../http/session.ts";
import { createProviderConnection, type ProviderConnection } from "../../model/connection.ts";

export const MONEYFORWARD_PROVIDER_ID = "moneyforward" as const;
export const DEFAULT_BASE_URL = "https://moneyforward.com";
export const DEFAULT_ID_BASE_URL = "https://id.moneyforward.com";

export type MoneyForwardAuthenticationState =
  | "empty"
  | "restored"
  | "valid"
  | "expired";

export interface MoneyForwardContext {
  readonly connection: ProviderConnection<typeof MONEYFORWARD_PROVIDER_ID>;
  readonly session: HttpSession;
  readonly baseURL: URL;
  readonly idBaseURL: URL;
  authenticationState: MoneyForwardAuthenticationState;
}

export interface MoneyForwardContextConfig {
  readonly connection?: ProviderConnection<typeof MONEYFORWARD_PROVIDER_ID>;
  readonly baseURL?: string;
  readonly idBaseURL?: string;
  readonly fetch?: Fetcher;
}

export function createMoneyForwardContext(
  config: MoneyForwardContextConfig = {},
): MoneyForwardContext {
  return {
    connection: config.connection ?? createProviderConnection(MONEYFORWARD_PROVIDER_ID, "default"),
    session: new HttpSession(config.fetch),
    baseURL: parseBaseURL(config.baseURL ?? DEFAULT_BASE_URL, "service"),
    idBaseURL: parseBaseURL(config.idBaseURL ?? DEFAULT_ID_BASE_URL, "ID"),
    authenticationState: "empty",
  };
}

function parseBaseURL(value: string, kind: string): URL {
  const result = new URL(value);
  if (
    (result.protocol !== "http:" && result.protocol !== "https:") ||
    result.username !== "" || result.password !== "" || result.search !== "" ||
    result.hash !== ""
  ) {
    throw new TypeError(`moneyforward: invalid ${kind} base URL`);
  }
  result.pathname = result.pathname.replace(/\/+$/, "");
  return result;
}
