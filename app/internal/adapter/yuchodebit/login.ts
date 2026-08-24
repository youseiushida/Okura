import { readTextLimitedWithCharset } from "../../http/body.ts";
import type {
  AuthenticationOptions,
  LoginOptions as PortLoginOptions,
} from "../../port/authentication.ts";
import type { UserIDPasswordCredentials } from "../../port/credentials.ts";
import type { TurnstileChallenge, TurnstileSolverPort } from "../../port/turnstile_solver.ts";
import { CARD_COMPANY_CODE, resolveYuchoDebitPath, type YuchoDebitContext } from "./context.ts";
import {
  AuthenticationFailedError,
  TurnstileVerificationError,
  UnexpectedPageError,
  YuchoDebitError,
} from "./errors.ts";
import {
  hasPrimaryCredentialError,
  hasTurnstileError,
  parseLoginPage,
  parsePageStatus,
  submissionBody,
} from "./parser.ts";
import { HOME_PATH, LOGIN_PATH, LOGIN_SUBMIT_PATH } from "./routes.ts";

export const DEFAULT_LOGIN_TIMEOUT_MS = 180_000;
export const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
export const MAX_RESPONSE_BYTES = 1 << 20;

export type Credentials = UserIDPasswordCredentials;

export interface LoginConfig {
  readonly solver: TurnstileSolverPort;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

export async function performLogin(
  context: YuchoDebitContext,
  credentials: Credentials,
  config: LoginConfig,
  options: PortLoginOptions,
): Promise<void> {
  const userID = credentials.userID.trim();
  if (userID === "") throw new TypeError("yucho-debit: user ID is required");
  if (credentials.password === "") throw new TypeError("yucho-debit: password is required");
  const timeoutMs = config.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("yucho-debit: login timeout must be positive");
  }
  const timeout = timeoutSignal(timeoutMs, options.signal);
  try {
    const initialURL = loginURL(context);
    const discovery = await fetchLoginPage(
      context,
      initialURL,
      config.userAgent ?? DEFAULT_USER_AGENT,
      timeout.signal,
    );
    const solution = await config.solver.solve(discovery.challenge, { signal: timeout.signal });
    validateSolution(solution.token, "token", 32 << 10);
    validateSolution(solution.userAgent, "User-Agent", 2 << 10);

    // The solver determines the User-Agent bound to the token. Reacquire the provider session and
    // Nablarch state with that agent before consuming the single-use token.
    context.session.cookies.clear();
    const login = await fetchLoginPage(context, initialURL, solution.userAgent, timeout.signal);
    if (!sameChallenge(discovery.challenge, login.challenge)) {
      throw new TurnstileVerificationError("Turnstile challenge changed while solving");
    }
    const body = submissionBody(login.submission, {
      usrId: userID,
      password: credentials.password,
      cc: CARD_COMPANY_CODE,
      "cf-turnstile-response": solution.token,
    });
    const action = new URL(login.submission.action);
    const response = await context.session.request(action, {
      method: "POST",
      signal: timeout.signal,
      headers: formHeaders(context, initialURL.href, solution.userAgent),
      body,
    });
    assertResponseOrigin(context, response, [LOGIN_SUBMIT_PATH, HOME_PATH], "login");
    const html = await limitedHTML(response, "login");
    const status = parsePageStatus(html);
    if (status === "authenticated") {
      context.userAgent = solution.userAgent;
      return;
    }
    if (status === "expired" && hasPrimaryCredentialError(html)) {
      throw new AuthenticationFailedError();
    }
    if (status === "expired" && hasTurnstileError(html)) {
      throw new TurnstileVerificationError("Turnstile token was rejected");
    }
    throw new UnexpectedPageError("login returned an unexpected page");
  } finally {
    timeout.dispose();
  }
}

export async function validateCurrentSession(
  context: YuchoDebitContext,
  options: AuthenticationOptions = {},
): Promise<boolean> {
  if (context.userAgent === "") return false;
  const url = resolveYuchoDebitPath(context, HOME_PATH);
  url.searchParams.set("cc", CARD_COMPANY_CODE);
  const response = await context.session.request(url, {
    headers: navigationHeaders(context.baseURL.href, context.userAgent),
    signal: options.signal,
  });
  assertResponseOrigin(context, response, [HOME_PATH, LOGIN_PATH], "validate session");
  if (response.status === 401) {
    await response.body?.cancel();
    return false;
  }
  const html = await limitedHTML(response, "validate session");
  const status = parsePageStatus(html);
  if (status === "authenticated") return true;
  if (status === "expired") return false;
  throw new UnexpectedPageError("session validation returned an unexpected page");
}

export function navigationHeaders(referer: string, userAgent: string): Headers {
  return new Headers({
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    Referer: referer,
    "User-Agent": userAgent,
  });
}

export function formHeaders(
  context: YuchoDebitContext,
  referer: string,
  userAgent: string,
): Headers {
  const headers = navigationHeaders(referer, userAgent);
  headers.set("Content-Type", "application/x-www-form-urlencoded");
  headers.set("Origin", context.baseURL.origin);
  return headers;
}

export async function limitedHTML(response: Response, operation: string): Promise<string> {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new YuchoDebitError(`${operation}: unexpected HTTP ${response.status}`);
  }
  return await readTextLimitedWithCharset(
    response,
    MAX_RESPONSE_BYTES,
    (limit) => new YuchoDebitError(`${operation}: response exceeds ${limit} bytes`),
    (charset, cause) =>
      new YuchoDebitError(`${operation}: decode response as ${charset}`, { cause }),
  );
}

async function fetchLoginPage(
  context: YuchoDebitContext,
  url: URL,
  userAgent: string,
  signal: AbortSignal,
) {
  const response = await context.session.request(url, {
    headers: navigationHeaders(context.baseURL.href, userAgent),
    signal,
  });
  assertResponseOrigin(context, response, [LOGIN_PATH], "open login page");
  const html = await limitedHTML(response, "open login page");
  return parseLoginPage(html, response.url || url.href);
}

function loginURL(context: YuchoDebitContext): URL {
  const result = resolveYuchoDebitPath(context, LOGIN_PATH);
  result.searchParams.set("cc", CARD_COMPANY_CODE);
  return result;
}

function sameChallenge(left: TurnstileChallenge, right: TurnstileChallenge): boolean {
  return left.pageURL === right.pageURL && left.siteKey === right.siteKey &&
    left.action === right.action && left.cData === right.cData &&
    left.chlPageData === right.chlPageData;
}

function validateSolution(value: string, name: string, maxLength: number): void {
  if (value === "" || value.length > maxLength || hasControlCharacter(value)) {
    throw new TurnstileVerificationError(`solver returned an invalid ${name}`);
  }
}

export function assertResponseOrigin(
  context: YuchoDebitContext,
  response: Response,
  expectedPaths: readonly string[],
  operation: string,
): void {
  if (response.url === "") return;
  const url = new URL(response.url);
  const path = url.pathname.replace(/;[^/]*$/, "");
  if (url.origin !== context.baseURL.origin || !expectedPaths.includes(path)) {
    throw new UnexpectedPageError(`${operation} returned an unexpected URL`);
  }
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): {
  readonly signal: AbortSignal;
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

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
