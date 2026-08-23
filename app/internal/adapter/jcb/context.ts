import { type Fetcher, HttpSession } from "../../http/session.ts";
import { createProviderConnection, type ProviderConnection } from "../../model/connection.ts";

export const JCB_PROVIDER_ID = "jcb" as const;
export const DEFAULT_BASE_URL = "https://my.jcb.co.jp";

export type JCBAuthenticationState =
  | "empty"
  | "restored"
  | "valid"
  | "expired";

export interface JCBContext {
  readonly connection: ProviderConnection<typeof JCB_PROVIDER_ID>;
  readonly session: HttpSession;
  readonly baseURL: URL;
  authenticationState: JCBAuthenticationState;
  userAgent: string;
}

export interface JCBContextConfig {
  readonly connection?: ProviderConnection<typeof JCB_PROVIDER_ID>;
  readonly baseURL?: string;
  readonly fetch?: Fetcher;
}

export function createJCBContext(config: JCBContextConfig = {}): JCBContext {
  const baseURL = new URL(config.baseURL ?? DEFAULT_BASE_URL);
  if (
    (baseURL.protocol !== "http:" && baseURL.protocol !== "https:") ||
    baseURL.username !== "" || baseURL.password !== "" || baseURL.search !== "" ||
    baseURL.hash !== ""
  ) {
    throw new TypeError(
      "jcb: base URL must contain only an HTTP(S) scheme, host, and optional path",
    );
  }
  baseURL.pathname = baseURL.pathname.replace(/\/+$/, "");
  return {
    connection: config.connection ?? createProviderConnection(JCB_PROVIDER_ID, "default"),
    session: new HttpSession(config.fetch),
    baseURL,
    authenticationState: "empty",
    userAgent: "",
  };
}

export function resolveJCBPath(context: JCBContext, path: string): URL {
  const result = new URL(context.baseURL);
  result.pathname = `${context.baseURL.pathname.replace(/\/$/, "")}${path}`;
  result.search = "";
  result.hash = "";
  return result;
}
