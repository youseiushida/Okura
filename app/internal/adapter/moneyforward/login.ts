import { discardLimited as discardResponseLimited, readTextLimited } from "../../http/body.ts";
import type {
  AuthenticationOptions,
  LoginOptions as PortLoginOptions,
} from "../../port/authentication.ts";
import type { EmailPasswordCredentials } from "../../port/credentials.ts";
import {
  extractCSRFToken,
  isCashFlowPage,
  MAX_RESPONSE_BYTES,
  MONEYFORWARD_USER_AGENT,
} from "./adapter.ts";
import { MONEYFORWARD_PROVIDER_ID, type MoneyForwardContext } from "./context.ts";
import {
  AuthenticationFailedError,
  UnexpectedPageError,
  VerificationFailedError,
} from "./errors.ts";

export const SIGN_IN_PATH = "/sign_in";
export const EMAIL_PATH = "/sign_in/email";
export const PASSWORD_PATH = "/sign_in/password";
export const EMAIL_OTP_PATH = "/email_otp";
export const PASSKEY_PROMOTION_PATH = "/passkey_promotion";
export const PASSKEY_COLLECT_PATH = "/passkey_promotion/collect";
export const PASSKEY_FINALIZE_PATH = "/passkey_promotion/finalize_passkey_setup";
const CASH_FLOW_PATH = "/cf";
const MAX_OTP_ATTEMPTS = 3;

export type Credentials = EmailPasswordCredentials;

export type LoginOptions = PortLoginOptions;

interface AuthPage {
  readonly html: string;
  readonly url: URL;
}

export async function performLogin(
  context: MoneyForwardContext,
  credentials: Credentials,
  options: LoginOptions,
): Promise<void> {
  const email = normalizeEmail(credentials.email);
  if (email === "") throw new TypeError("moneyforward: email is required");
  if (credentials.password === "") throw new TypeError("moneyforward: password is required");

  const initialResponse = await context.session.request(new URL(SIGN_IN_PATH, context.baseURL), {
    headers: navigationHeaders(context.baseURL.href),
    signal: options.signal,
  });
  let page = await authPage(initialResponse, context, SIGN_IN_PATH);

  page = await submitAuthPage(context, page, EMAIL_PATH, {
    "mfid_user[email]": email,
    "mfid_user[password]": "",
  }, options.signal);
  if (!isIDPage(page, context, PASSWORD_PATH)) {
    if (isCredentialEntryPage(page, context)) {
      throw new AuthenticationFailedError("Money Forward rejected the email");
    }
    throw new UnexpectedPageError("Money Forward email step returned an unexpected page");
  }

  page = await submitAuthPage(context, page, SIGN_IN_PATH, {
    "mfid_user[email]": email,
    "mfid_user[password]": credentials.password,
  }, options.signal);
  if (!isIDPage(page, context, EMAIL_OTP_PATH)) {
    if (isCredentialEntryPage(page, context)) {
      throw new AuthenticationFailedError("Money Forward rejected the email or password");
    }
    throw new UnexpectedPageError("Money Forward password step returned an unexpected page");
  }

  await options.interaction.progress.publish({
    kind: "code-sent",
    provider: MONEYFORWARD_PROVIDER_ID,
    step: "login-email-otp",
    channel: "email",
    destinationHint: maskEmail(email),
  }, { signal: options.signal });

  let passkeyPage: AuthPage | undefined;
  let returnedToService = false;
  for (let attempt = 1; attempt <= MAX_OTP_ATTEMPTS; attempt += 1) {
    const reply = await options.interaction.otp.request({
      provider: MONEYFORWARD_PROVIDER_ID,
      step: "login-email-otp",
      attempt,
      channel: "email",
      destinationHint: maskEmail(email),
      format: "numeric",
      length: { min: 6, max: 6 },
      resend: { allowed: false },
    }, { signal: options.signal });
    if (reply.action !== "submit") {
      throw new VerificationFailedError("Money Forward email OTP cannot be resent here");
    }
    const code = reply.code.trim();
    if (!/^\d{6}$/.test(code)) {
      throw new VerificationFailedError("Money Forward email OTP must be 6 digits");
    }
    const otpResponse = await postAuthPage(
      context,
      page,
      EMAIL_OTP_PATH,
      { email_otp: code },
      options.signal,
    );
    if (isSuccessfulServiceResponse(otpResponse, context)) {
      await discardLimited(otpResponse);
      returnedToService = true;
      break;
    }
    const response = await authPage(otpResponse, context);
    if (isIDPage(response, context, PASSKEY_PROMOTION_PATH)) {
      passkeyPage = response;
      break;
    }
    if (!isIDPage(response, context, EMAIL_OTP_PATH)) {
      throw new UnexpectedPageError("Money Forward OTP returned an unexpected page");
    }
    page = response;
  }
  if (passkeyPage === undefined && !returnedToService) {
    throw new VerificationFailedError("Money Forward rejected the email OTP");
  }

  if (passkeyPage !== undefined) {
    await skipPasskeyPromotion(context, passkeyPage, options.signal);
  }
  if (!(await validateCurrentSession(context, options))) {
    throw new UnexpectedPageError("Money Forward login did not create a valid session");
  }
}

export async function validateCurrentSession(
  context: MoneyForwardContext,
  options: AuthenticationOptions = {},
): Promise<boolean> {
  const response = await context.session.request(new URL(CASH_FLOW_PATH, context.baseURL), {
    headers: navigationHeaders(context.baseURL.href),
    signal: options.signal,
  });
  if (isAuthenticationResponse(response, context)) {
    await discardLimited(response);
    return false;
  }
  if (response.status !== 200) {
    await discardLimited(response);
    throw new UnexpectedPageError(
      `Money Forward session validation returned HTTP ${response.status}`,
    );
  }
  const url = responseURL(response, "Money Forward session validation");
  if (url.origin !== context.baseURL.origin || url.pathname !== CASH_FLOW_PATH) {
    await discardLimited(response);
    throw new UnexpectedPageError("Money Forward session validation returned an unexpected URL");
  }
  const html = await decodeLimited(response);
  if (!isCashFlowPage(html)) {
    throw new UnexpectedPageError("Money Forward session validation page was not recognizable");
  }
  return true;
}

async function submitAuthPage(
  context: MoneyForwardContext,
  page: AuthPage,
  path: string,
  values: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<AuthPage> {
  return await authPage(await postAuthPage(context, page, path, values, signal), context);
}

async function postAuthPage(
  context: MoneyForwardContext,
  page: AuthPage,
  path: string,
  values: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<Response> {
  requireIDOrigin(page, context);
  return await context.session.request(new URL(path, context.idBaseURL), {
    method: "POST",
    headers: formHeaders(page.url.href),
    body: authFormBody(page, values),
    signal,
  });
}

function authFormBody(page: AuthPage, values: Readonly<Record<string, string>>): URLSearchParams {
  const body = new URLSearchParams({
    authenticity_token: extractCSRFToken(page.html),
    _method: "post",
    clientId: requiredQuery(page.url, "client_id"),
    redirectUri: requiredQuery(page.url, "redirect_uri"),
    responseType: requiredQuery(page.url, "response_type"),
    scope: requiredQuery(page.url, "scope"),
    state: requiredQuery(page.url, "state"),
    codeChallenge: requiredQuery(page.url, "code_challenge"),
    codeChallengeMethod: requiredQuery(page.url, "code_challenge_method"),
    nonce: requiredQuery(page.url, "nonce"),
  });
  for (const [name, value] of Object.entries(values)) body.set(name, value);
  return body;
}

async function skipPasskeyPromotion(
  context: MoneyForwardContext,
  page: AuthPage,
  signal?: AbortSignal,
): Promise<void> {
  requireIDPage(
    page,
    context,
    PASSKEY_PROMOTION_PATH,
    () => new VerificationFailedError("Money Forward rejected the OTP step"),
  );
  const parameters = camelCaseOAuthParameters(page.url);
  const collectURL = new URL(PASSKEY_COLLECT_PATH, context.idBaseURL);
  collectURL.searchParams.set("event", "passkey_rejected");
  collectURL.searchParams.set("error", "");
  for (const [name, value] of parameters) collectURL.searchParams.set(name, value);
  const collectResponse = await context.session.request(collectURL, {
    method: "POST",
    headers: new Headers({
      Accept: "*/*",
      "Content-Type": "text/plain;charset=UTF-8",
      Origin: context.idBaseURL.origin,
      Referer: page.url.href,
      "User-Agent": MONEYFORWARD_USER_AGENT,
      "X-CSRF-Token": extractCSRFToken(page.html),
    }),
    signal,
  });
  await discardLimited(collectResponse);
  if (collectResponse.status !== 204) {
    throw new UnexpectedPageError(
      `Money Forward passkey skip returned HTTP ${collectResponse.status}`,
    );
  }

  const finalizeURL = new URL(PASSKEY_FINALIZE_PATH, context.idBaseURL);
  for (const [name, value] of parameters) finalizeURL.searchParams.set(name, value);
  const finalizeResponse = await context.session.request(finalizeURL, {
    headers: navigationHeaders(page.url.href),
    signal,
  });
  await discardLimited(finalizeResponse);
  if (finalizeResponse.status < 200 || finalizeResponse.status >= 400) {
    throw new UnexpectedPageError(
      `Money Forward login finalization returned HTTP ${finalizeResponse.status}`,
    );
  }
  const url = responseURL(finalizeResponse, "Money Forward login finalization");
  if (url.origin !== context.baseURL.origin) {
    throw new UnexpectedPageError("Money Forward login finalization did not return to the service");
  }
}

async function authPage(
  response: Response,
  context: MoneyForwardContext,
  expectedPath?: string,
): Promise<AuthPage> {
  if (response.status !== 200) {
    await discardLimited(response);
    throw new UnexpectedPageError(`Money Forward ID returned HTTP ${response.status}`);
  }
  const url = responseURL(response, "Money Forward ID");
  if (
    url.origin !== context.idBaseURL.origin ||
    (expectedPath !== undefined && url.pathname !== expectedPath)
  ) {
    await discardLimited(response);
    throw new UnexpectedPageError(
      `Money Forward ID expected ${context.idBaseURL.origin}${expectedPath ?? "/*"}, ` +
        `but returned ${url.origin}${url.pathname}`,
    );
  }
  const html = await decodeLimited(response);
  extractCSRFToken(html);
  return { html, url };
}

function isSuccessfulServiceResponse(
  response: Response,
  context: MoneyForwardContext,
): boolean {
  if (response.status < 200 || response.status >= 400 || response.url === "") return false;
  return new URL(response.url).origin === context.baseURL.origin;
}

function requireIDPage(
  page: AuthPage,
  context: MoneyForwardContext,
  path: string,
  failure: () => Error,
): void {
  if (!isIDPage(page, context, path)) {
    throw failure();
  }
}

function requireIDOrigin(page: AuthPage, context: MoneyForwardContext): void {
  if (page.url.origin !== context.idBaseURL.origin) {
    throw new UnexpectedPageError("Money Forward ID page has an unexpected origin");
  }
}

function isIDPage(page: AuthPage, context: MoneyForwardContext, path: string): boolean {
  return page.url.origin === context.idBaseURL.origin && page.url.pathname === path;
}

function isCredentialEntryPage(page: AuthPage, context: MoneyForwardContext): boolean {
  return [SIGN_IN_PATH, EMAIL_PATH, PASSWORD_PATH].some((path) => isIDPage(page, context, path));
}

function camelCaseOAuthParameters(url: URL): URLSearchParams {
  const result = new URLSearchParams();
  for (
    const [target, source] of [
      ["clientId", "client_id"],
      ["redirectUri", "redirect_uri"],
      ["responseType", "response_type"],
      ["scope", "scope"],
      ["state", "state"],
      ["codeChallenge", "code_challenge"],
      ["codeChallengeMethod", "code_challenge_method"],
      ["nonce", "nonce"],
    ] as const
  ) result.set(target, requiredQuery(url, source));
  return result;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value === "") {
    throw new UnexpectedPageError(`Money Forward ID URL is missing ${name}`);
  }
  return value;
}

function navigationHeaders(referer: string): Headers {
  return new Headers({
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en;q=0.9,en-US;q=0.8",
    Referer: referer,
    "User-Agent": MONEYFORWARD_USER_AGENT,
  });
}

function formHeaders(referer: string): Headers {
  const headers = navigationHeaders(referer);
  headers.set("Content-Type", "application/x-www-form-urlencoded");
  headers.set("Origin", new URL(referer).origin);
  return headers;
}

function isAuthenticationResponse(response: Response, context: MoneyForwardContext): boolean {
  if (response.status === 401) return true;
  if (response.url === "") return false;
  const url = new URL(response.url);
  return url.origin === context.idBaseURL.origin ||
    (url.origin === context.baseURL.origin &&
      (url.pathname === SIGN_IN_PATH || url.pathname.startsWith("/auth/mfid")));
}

function responseURL(response: Response, stage: string): URL {
  try {
    if (response.url === "") throw new Error("missing URL");
    return new URL(response.url);
  } catch {
    throw new UnexpectedPageError(`${stage} response URL was invalid`);
  }
}

async function decodeLimited(response: Response): Promise<string> {
  return await readTextLimited(
    response,
    MAX_RESPONSE_BYTES,
    (value) => new UnexpectedPageError(`Money Forward response exceeds ${value} bytes`),
  );
}

async function discardLimited(response: Response): Promise<void> {
  await discardResponseLimited(
    response,
    MAX_RESPONSE_BYTES,
    (value) => new UnexpectedPageError(`Money Forward response exceeds ${value} bytes`),
  );
}

function normalizeEmail(value: string): string {
  return value.trim().replaceAll("\\@", "@").replaceAll("＠", "@");
}

function maskEmail(value: string): string {
  const separator = value.lastIndexOf("@");
  if (separator <= 0) return "***";
  const local = value.slice(0, separator);
  return `${local.slice(0, 1)}***@${value.slice(separator + 1)}`;
}
