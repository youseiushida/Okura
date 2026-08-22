import type { JCBAdapter } from "./adapter.ts";
import {
  discardLimited as discardResponseLimited,
  readTextLimited as readResponseTextLimited,
} from "../../http/body.ts";
import { MAX_RESPONSE_BYTES } from "./adapter.ts";
import { AuthenticationFailedError, JCBError } from "./errors.ts";
import { executeProtectionIsolated } from "./protection_worker_client.ts";
import type { HttpSession } from "./session.ts";

export const LOGIN_PATH = "/Login";
export const LOGIN_SUBMIT_PATH = "/iss-pc/member/user_manage/Login";
export const MYPAGE_PATH = "/iss-pc/member/mypage/mypage.html";
export const DEFAULT_LOGIN_TIMEOUT_MS = 45_000;
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export interface Credentials {
  userID: string;
  password: string;
}

export interface ProtectedForm {
  action: string;
  body: string;
  userAgent: string;
}

export interface ProtectionContext {
  session: HttpSession;
  loginURL: URL;
  credentials: Credentials;
  userAgent: string;
  signal: AbortSignal;
}

export type ProtectionGenerator = (context: ProtectionContext) => Promise<ProtectedForm>;

export interface LoginOptions {
  userAgent?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  generateProtection?: ProtectionGenerator;
}

interface RuntimeInput {
  userID: string;
  password: string;
  userAgent: string;
}

interface RuntimeRequest {
  input: RuntimeInput;
  loginURL: string;
  initURL: string;
  asyncURL: string;
  initSource: string;
  asyncSource: string;
  cookieHeader: string;
}

interface RuntimeResult {
  action: string;
  body: string;
  cookieUpdates: string[];
}

export async function createAuthenticated(
  config: ConstructorParameters<typeof JCBAdapter>[0],
  credentials: Credentials,
  options: LoginOptions = {},
): Promise<JCBAdapter> {
  const { JCBAdapter } = await import("./adapter.ts");
  const adapter = new JCBAdapter(config);
  await adapter.login(credentials, options);
  return adapter;
}

export async function performLogin(
  adapter: JCBAdapter,
  credentials: Credentials,
  options: LoginOptions,
): Promise<void> {
  if (credentials.userID.trim() === "") throw new TypeError("jcb: MyJCB user ID is required");
  if (credentials.password === "") throw new TypeError("jcb: MyJCB password is required");
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  if (timeoutMs < 0) throw new TypeError("jcb: login timeout must not be negative");

  const timeout = timeoutSignal(timeoutMs, options.signal);
  try {
    const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    const loginURL = adapter.resolvePath(LOGIN_PATH);
    const generator = options.generateProtection ?? generateProtection;
    const form = await generator({
      session: adapter.session,
      loginURL,
      credentials,
      userAgent,
      signal: timeout.signal,
    });

    const action = new URL(form.action);
    if (action.origin !== adapter.baseURL.origin || action.pathname !== LOGIN_SUBMIT_PATH) {
      throw new JCBError(`reject unexpected login form action ${JSON.stringify(form.action)}`);
    }
    validateProtectedBody(form.body, credentials);

    const response = await adapter.session.request(action, {
      method: "POST",
      signal: timeout.signal,
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: adapter.baseURL.origin,
        Referer: loginURL.href,
        "User-Agent": form.userAgent || userAgent,
      },
      body: form.body,
    });
    await discardLimited(response, MAX_RESPONSE_BYTES);
    if (!isMypageResponse(response)) {
      const landingPath = response.url === "" ? "" : new URL(response.url).pathname;
      throw new AuthenticationFailedError(response.status, landingPath);
    }
    adapter.userAgent = form.userAgent || userAgent;
  } finally {
    timeout.dispose();
  }
}

export async function generateProtection(context: ProtectionContext): Promise<ProtectedForm> {
  const { session, loginURL, credentials, userAgent, signal } = context;
  const loginResponse = await session.request(loginURL, {
    signal,
    headers: protectionHeaders(userAgent, loginURL.origin),
  });
  if (!loginResponse.ok) throw new JCBError(`GET ${loginURL}: HTTP ${loginResponse.status}`);
  const loginHTML = await readTextLimited(loginResponse, MAX_RESPONSE_BYTES);
  const initURL = extractProtectionURL(
    loginHTML,
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']*\/apl\/login-prot\.js\?init[^"']*)["']/i,
    loginURL,
    "init",
  );
  const initResponse = await session.request(initURL, {
    signal,
    headers: protectionHeaders(userAgent, loginURL.href),
  });
  if (!initResponse.ok) throw new JCBError(`GET ${initURL}: HTTP ${initResponse.status}`);
  const initSource = await readTextLimited(initResponse, MAX_RESPONSE_BYTES);
  const asyncURL = extractProtectionURL(
    initSource,
    /(?:\bu\s*=|\.src\s*=)\s*["']([^"']*\/apl\/login-prot\.js\?async[^"']*)["']/,
    initURL,
    "async",
  );
  const asyncResponse = await session.request(asyncURL, {
    signal,
    headers: protectionHeaders(userAgent, initURL.href),
  });
  if (!asyncResponse.ok) throw new JCBError(`GET ${asyncURL}: HTTP ${asyncResponse.status}`);
  const asyncSource = await readTextLimited(asyncResponse, MAX_RESPONSE_BYTES);

  const request: RuntimeRequest = {
    input: { userID: credentials.userID, password: credentials.password, userAgent },
    loginURL: loginURL.href,
    initURL: initURL.href,
    asyncURL: asyncURL.href,
    initSource,
    asyncSource,
    cookieHeader: session.cookies.header(loginURL, false),
  };
  const result: RuntimeResult = await executeProtectionIsolated(request, signal);
  for (const cookie of result.cookieUpdates) session.cookies.set(cookie, loginURL, false);
  return { ...result, userAgent };
}

export function validateProtectedBody(body: string, credentials: Credentials): void {
  const values = new URLSearchParams(body);
  if (
    values.get("userId") !== credentials.userID || values.get("password") !== credentials.password
  ) {
    throw new JCBError("protected form did not preserve credentials");
  }
  if (!values.get("screenId") || !values.get("loginRouteId")) {
    throw new JCBError("protected form is missing login route fields");
  }
  const staticNames = new Set(["userId", "password", "screenId", "loginRouteId"]);
  const protectedNames = new Set([...values.keys()].filter((name) => !staticNames.has(name)));
  if (protectedNames.size < 6) {
    throw new JCBError("protection script did not generate all dynamic fields");
  }
}

export function isMypageResponse(response: Response): boolean {
  if (response.status < 200 || response.status >= 400) return false;
  if (response.status >= 300) {
    const location = response.headers.get("Location");
    return location !== null &&
      normalizedPath(new URL(location, response.url || "https://invalid.local")) ===
        normalizedPath(new URL(MYPAGE_PATH, "https://invalid.local"));
  }
  return response.url !== "" &&
    normalizedPath(new URL(response.url)) ===
      normalizedPath(new URL(MYPAGE_PATH, "https://invalid.local"));
}

function extractProtectionURL(
  source: string,
  pattern: RegExp,
  baseURL: URL,
  kind: string,
): URL {
  const path = source.match(pattern)?.[1]?.replaceAll("&amp;", "&");
  if (path === undefined) throw new JCBError(`MyJCB ${kind} protection script URL was not found`);
  const result = new URL(path, baseURL);
  if (result.origin !== baseURL.origin) {
    throw new JCBError(`MyJCB ${kind} protection script is cross-origin`);
  }
  return result;
}

function protectionHeaders(userAgent: string, referer: string): Headers {
  return new Headers({
    Accept: "text/html,application/xhtml+xml,application/javascript,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    Referer: referer,
    "User-Agent": userAgent,
  });
}

async function readTextLimited(response: Response, limit: number): Promise<string> {
  return await readResponseTextLimited(
    response,
    limit,
    (value) => new JCBError(`response exceeds ${value} bytes`),
  );
}

async function discardLimited(response: Response, limit: number): Promise<void> {
  await discardResponseLimited(
    response,
    limit,
    (value) => new JCBError(`response exceeds ${value} bytes`),
  );
}

function normalizedPath(url: URL): string {
  return url.pathname.toLowerCase().replace(/\/+$/, "");
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abortFromParent, { once: true });
  if (parent?.aborted) abortFromParent();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Login timed out", "TimeoutError")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}
