import type { HttpSession } from "../../http/session.ts";
import { readTextLimited } from "../../http/body.ts";
import {
  AuthenticationFailedError,
  UnexpectedPageError,
  VerificationRequiredError,
} from "./errors.ts";
import { documentFieldValue, findForm, findFormByAction, formBody } from "./forms.ts";
import { AMAZON_USER_AGENT, parseAmazonPage } from "./runtime.ts";
import { executeAmazonScriptsIsolated } from "./script_worker_client.ts";

export const SIGN_IN_PATH = "/ap/signin";
export const ORDER_HISTORY_PATH = "/gp/css/order-history";
const CLAIM_PATH = "/ax/claim";
const VERIFY_OTP_PATH = "/ap/cvf/approval/verifyOtp";
const MAX_LOGIN_RESPONSE_BYTES = 2 << 20;

export interface Credentials {
  email: string;
  password: string;
}

export interface LoginTarget {
  session: HttpSession;
  baseURL: URL;
}

export interface LoginOptions {
  askVerificationCode?: () => Promise<string>;
  signal?: AbortSignal;
}

export async function performLogin(
  target: LoginTarget,
  credentials: Credentials,
  options: LoginOptions = {},
): Promise<void> {
  if (credentials.email.trim() === "") throw new TypeError("amazon: email is required");
  if (credentials.password === "") throw new TypeError("amazon: password is required");

  const signInURL = loginURL(target.baseURL);
  const claimResponse = await target.session.request(signInURL, {
    headers: navigationHeaders(target.baseURL.href),
    signal: options.signal,
  });
  const claimHTML = await decodeLimitedResponse(claimResponse, MAX_LOGIN_RESPONSE_BYTES);
  if (isWAFPage(claimHTML)) {
    throw new UnexpectedPageError("Amazon returned an AWS WAF challenge");
  }

  const claim = await executeAmazonScriptsIsolated({
    kind: "claim",
    html: claimHTML,
    url: claimResponse.url,
    value: credentials.email.trim(),
  }, options.signal);
  const claimAction = validatedFormAction(
    claim.action,
    claimResponse.url,
    target.baseURL,
    CLAIM_PATH,
  );
  const claimBody = new URLSearchParams(claim.body);
  for (const [name, value] of signInURL.searchParams) claimBody.set(name, value);
  const passwordResponse = await target.session.request(claimAction, {
    method: "POST",
    headers: formHeaders(claimResponse.url),
    body: claimBody,
    signal: options.signal,
  });

  const passwordHTML = await decodeLimitedResponse(passwordResponse, MAX_LOGIN_RESPONSE_BYTES);
  if (!hasFormField(passwordHTML, passwordResponse.url, "password")) {
    throw authenticationFailure(passwordResponse, passwordHTML, "email", credentials.email);
  }
  const password = await executeAmazonScriptsIsolated({
    kind: "password",
    html: passwordHTML,
    url: passwordResponse.url,
    value: credentials.password,
  }, options.signal);
  const passwordAction = validatedFormAction(
    password.action,
    passwordResponse.url,
    target.baseURL,
    SIGN_IN_PATH,
  );
  const loginResponse = await target.session.request(passwordAction, {
    method: "POST",
    headers: formHeaders(passwordResponse.url),
    body: new URLSearchParams(password.body),
    signal: options.signal,
  });

  let response = loginResponse;
  let html = await decodeLimitedResponse(response, MAX_LOGIN_RESPONSE_BYTES);
  if (isVerificationPage(response, html)) {
    response = await submitVerification(target, response, html, options);
    html = await decodeLimitedResponse(response, MAX_LOGIN_RESPONSE_BYTES);
  }
  if (isAuthenticationPage(response) || isVerificationPage(response, html)) {
    throw authenticationFailure(response, html, "password or verification", credentials.email);
  }

  const historyURL = new URL(ORDER_HISTORY_PATH, target.baseURL);
  const historyResponse = await target.session.request(historyURL, {
    headers: navigationHeaders(response.url),
    signal: options.signal,
  });
  const historyHTML = await decodeLimitedResponse(historyResponse, MAX_LOGIN_RESPONSE_BYTES);
  validateAuthenticatedHistory(historyResponse, historyHTML, target.baseURL);
}

export function validateAuthenticatedHistory(
  response: Response,
  html: string,
  baseURL: URL,
): void {
  if (isAuthenticationPage(response) || response.status === 401 || response.status === 403) {
    throw new AuthenticationFailedError();
  }
  if (response.status !== 200) {
    throw new UnexpectedPageError(`Amazon order history returned HTTP ${response.status}`);
  }
  let url: URL;
  try {
    if (response.url === "") throw new Error("missing response URL");
    url = new URL(response.url);
  } catch {
    throw new UnexpectedPageError("Amazon order history response URL was invalid");
  }
  if (
    url.origin !== baseURL.origin ||
    (url.pathname !== ORDER_HISTORY_PATH && url.pathname !== "/your-orders/orders")
  ) {
    throw new UnexpectedPageError("Amazon order history redirected to an unexpected page");
  }
  if (isWAFPage(html) || isCaptchaPage(html)) {
    throw new AuthenticationFailedError("Amazon requested a WAF or CAPTCHA challenge");
  }
  if (!isOrderHistoryPage(html)) {
    throw new UnexpectedPageError("Amazon order history page was not recognizable");
  }
}

function loginURL(baseURL: URL): URL {
  const url = new URL(SIGN_IN_PATH, baseURL);
  url.searchParams.set("openid.return_to", new URL(ORDER_HISTORY_PATH, baseURL).href);
  url.searchParams.set(
    "openid.identity",
    "http://specs.openid.net/auth/2.0/identifier_select",
  );
  url.searchParams.set("openid.assoc_handle", "anywhere_v2_jp");
  url.searchParams.set("openid.mode", "checkid_setup");
  url.searchParams.set(
    "openid.claimed_id",
    "http://specs.openid.net/auth/2.0/identifier_select",
  );
  url.searchParams.set("openid.ns", "http://specs.openid.net/auth/2.0");
  return url;
}

async function submitVerification(
  target: LoginTarget,
  response: Response,
  html: string,
  options: LoginOptions,
): Promise<Response> {
  if (options.askVerificationCode === undefined) throw new VerificationRequiredError();
  const code = (await options.askVerificationCode()).trim();
  if (code === "") throw new VerificationRequiredError("Amazon verification code is required");

  const dom = parseAmazonPage(html, response.url);
  try {
    const document = dom.window.document;
    const form = findForm(document, "otpCode") ?? findFormByAction(document, VERIFY_OTP_PATH);
    const body = form === undefined ? new URLSearchParams() : formBody(form);
    body.set("otpCode", code);
    const currentURL = new URL(response.url);
    for (
      const name of [
        "arb",
        "openid.return_to",
        "pageId",
        "openid.assoc_handle",
        "disableRedirect",
        "isResend",
        "isIncomingSmsResponded",
        "isRedirectForIncomingSms",
        "isRedirectForWhatsapp",
        "isRedirectForSms",
        "isWhatsAppOptionClickedOnNonBlockCX",
        "csrfToken",
      ]
    ) {
      if (body.has(name)) continue;
      const value = documentFieldValue(document, name) || currentURL.searchParams.get(name) || "";
      body.set(name, value);
    }
    const action = form === undefined
      ? new URL(VERIFY_OTP_PATH, target.baseURL)
      : new URL(form.action, response.url);
    return await target.session.request(action, {
      method: "POST",
      headers: formHeaders(response.url),
      body,
      signal: options.signal,
    });
  } finally {
    dom.window.close();
  }
}

function navigationHeaders(referer: string): Headers {
  return new Headers({
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "ja,en;q=0.9,en-US;q=0.8",
    Referer: referer,
    "Sec-CH-UA": '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
    "Sec-CH-UA-Mobile": "?1",
    "Sec-CH-UA-Platform": '"Android"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": AMAZON_USER_AGENT,
  });
}

function formHeaders(referer: string): Headers {
  const headers = navigationHeaders(referer);
  headers.set("Content-Type", "application/x-www-form-urlencoded");
  headers.set("Origin", new URL(referer).origin);
  return headers;
}

function validatedFormAction(
  value: string,
  base: string,
  expectedOrigin: URL,
  expectedPath: string,
): URL {
  const action = new URL(value, base);
  if (action.origin !== expectedOrigin.origin || action.pathname !== expectedPath) {
    throw new UnexpectedPageError("Amazon login form action was unexpected");
  }
  return action;
}

function hasFormField(html: string, url: string, name: string): boolean {
  const dom = parseAmazonPage(html, url);
  try {
    return findForm(dom.window.document, name) !== undefined;
  } finally {
    dom.window.close();
  }
}

function isAuthenticationPage(response: Response): boolean {
  const path = response.url === "" ? "" : new URL(response.url).pathname;
  return path === SIGN_IN_PATH || path === CLAIM_PATH;
}

function isVerificationPage(response: Response, html: string): boolean {
  const path = response.url === "" ? "" : new URL(response.url).pathname;
  return path.startsWith("/ap/cvf/") || /name=["']otpCode["']/i.test(html);
}

function isWAFPage(html: string): boolean {
  return /awswaf\.com|aws-waf-token|challenge-container/i.test(html);
}

function isCaptchaPage(html: string): boolean {
  return /amzn-captcha|name=["'](?:guess|cvf_captcha_input)["']|captcha-container/i.test(html);
}

function isOrderHistoryPage(html: string): boolean {
  return /past-purchase-tile|ordersContainer|your-orders|orderFilter|timeFilter|注文履歴|(?:ご)?注文(?:は|が)(?:ありません|見つかりません)|Your Orders|No orders/i
    .test(html);
}

function authenticationFailure(
  response: Response,
  html: string,
  stage: string,
  email: string,
): AuthenticationFailedError {
  const path = response.url === "" ? "unknown URL" : new URL(response.url).pathname;
  if (isWAFPage(html)) {
    return new AuthenticationFailedError(
      `Amazon requested an AWS WAF challenge during the ${stage} step (${path})`,
    );
  }
  const dom = parseAmazonPage(html, response.url || "https://www.amazon.co.jp/");
  try {
    const document = dom.window.document;
    if (
      document.querySelector(
        "#aa-challenge-page-captcha-container, .amzn-captcha-modal, input[name='guess'], input[name='cvf_captcha_input']",
      ) !== null
    ) {
      return new AuthenticationFailedError(
        `Amazon requested a CAPTCHA during the ${stage} step (${path})`,
      );
    }
    for (
      const selector of [
        "#auth-error-message-box .a-alert-content",
        "#auth-warning-message-box .a-alert-content",
        ".cvf-widget-alert .a-alert-content",
        ".a-alert-error:not(.aok-hidden) .a-alert-content",
      ]
    ) {
      for (const element of document.querySelectorAll(selector)) {
        if (element.closest(".aok-hidden, [aria-hidden='true']") !== null) continue;
        const message = sanitizeServerMessage(element.textContent ?? "", email);
        if (message !== "") {
          return new AuthenticationFailedError(
            `Amazon rejected the ${stage} step (${path}): ${message}`,
          );
        }
      }
    }
  } finally {
    dom.window.close();
  }
  return new AuthenticationFailedError(`Amazon rejected the ${stage} step (${path})`);
}

function sanitizeServerMessage(value: string, email: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized === "") return "";
  const redacted = email === "" ? normalized : normalized.replaceAll(email, "[email]");
  return redacted.slice(0, 300);
}

async function decodeLimitedResponse(response: Response, limit: number): Promise<string> {
  return await readTextLimited(
    response,
    limit,
    (value) => new UnexpectedPageError(`Amazon response exceeds ${value} bytes`),
  );
}
