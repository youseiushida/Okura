import { type Fetcher, HttpSession } from "../../http/session.ts";
import { createProviderConnection, type ProviderConnection } from "../../model/connection.ts";

export const AMAZON_PROVIDER_ID = "amazon" as const;
export const DEFAULT_BASE_URL = "https://www.amazon.co.jp";

export type AmazonAuthenticationState =
  | "empty"
  | "restored"
  | "valid"
  | "expired";

export interface AmazonContext {
  readonly connection: ProviderConnection<typeof AMAZON_PROVIDER_ID>;
  readonly session: HttpSession;
  readonly baseURL: URL;
  authenticationState: AmazonAuthenticationState;
}

export interface AmazonContextConfig {
  readonly connection?: ProviderConnection<typeof AMAZON_PROVIDER_ID>;
  readonly baseURL?: string;
  readonly fetch?: Fetcher;
}

export function createAmazonContext(config: AmazonContextConfig = {}): AmazonContext {
  const baseURL = new URL(config.baseURL ?? DEFAULT_BASE_URL);
  if (
    (baseURL.protocol !== "http:" && baseURL.protocol !== "https:") ||
    baseURL.username !== "" || baseURL.password !== "" || baseURL.search !== "" ||
    baseURL.hash !== ""
  ) {
    throw new TypeError("amazon: invalid base URL");
  }
  baseURL.pathname = baseURL.pathname.replace(/\/+$/, "");
  return {
    connection: config.connection ?? createProviderConnection(AMAZON_PROVIDER_ID, "default"),
    session: new HttpSession(config.fetch),
    baseURL,
    authenticationState: "empty",
  };
}
