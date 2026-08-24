import { type CookieSnapshot, parseCookieSnapshot } from "../../http/session.ts";
import type {
  AuthenticationOptions,
  AuthenticationPort,
  JsonObject,
  LoginOptions as PortLoginOptions,
  ProviderSessionSnapshot,
  SessionRestoreResult,
  SessionValidation,
} from "../../port/authentication.ts";
import { YUCHO_DEBIT_PROVIDER_ID, type YuchoDebitContext } from "./context.ts";
import {
  type Credentials,
  type LoginConfig,
  performLogin,
  validateCurrentSession,
} from "./login.ts";

const SNAPSHOT_SCHEMA_VERSION = 1;

export class YuchoDebitAuthentication
  implements AuthenticationPort<typeof YUCHO_DEBIT_PROVIDER_ID, Credentials> {
  readonly provider = YUCHO_DEBIT_PROVIDER_ID;
  readonly connection;
  readonly #context: YuchoDebitContext;
  readonly #loginConfig: LoginConfig;

  constructor(context: YuchoDebitContext, loginConfig: LoginConfig) {
    this.#context = context;
    this.#loginConfig = loginConfig;
    this.connection = context.connection;
  }

  restoreSession(snapshot: unknown): SessionRestoreResult {
    this.clearSession();
    if (
      !isRecord(snapshot) ||
      !hasOnlyKeys(snapshot, [
        "schemaVersion",
        "provider",
        "connectionID",
        "capturedAt",
        "payload",
      ])
    ) return rejected("malformed");
    if (snapshot.provider !== this.provider) return rejected("provider-mismatch");
    if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      return Number.isInteger(snapshot.schemaVersion)
        ? rejected("unsupported-schema")
        : rejected("malformed");
    }
    if (typeof snapshot.connectionID !== "string") return rejected("malformed");
    if (snapshot.connectionID !== this.connection.id) return rejected("connection-mismatch");
    if (
      !isValidCapturedAt(snapshot.capturedAt) || !isRecord(snapshot.payload) ||
      !hasOnlyKeys(snapshot.payload, ["cookies", "userAgent"])
    ) {
      return rejected("malformed");
    }
    const userAgent = snapshot.payload.userAgent;
    if (typeof userAgent !== "string" || userAgent === "" || hasControlCharacter(userAgent)) {
      return rejected("malformed");
    }
    try {
      if (!hasOnlyCookieFields(snapshot.payload.cookies)) return rejected("malformed");
      const cookies = parseCookieSnapshot(snapshot.payload.cookies);
      if (cookies.some((cookie) => !cookieDomainMatches(this.#context.baseURL, cookie.domain))) {
        return rejected("malformed");
      }
      this.#context.session.cookies.restore(cookies);
    } catch {
      return rejected("malformed");
    }
    this.#context.userAgent = userAgent;
    this.#context.authenticationState = "restored";
    return { status: "restored" };
  }

  async validateSession(options: AuthenticationOptions = {}): Promise<SessionValidation> {
    if (this.#context.authenticationState !== "restored") return { status: "expired" };
    const valid = await validateCurrentSession(this.#context, options);
    this.#context.authenticationState = valid ? "valid" : "expired";
    return { status: valid ? "valid" : "expired" };
  }

  async login(credentials: Credentials, options: PortLoginOptions): Promise<void> {
    this.clearSession();
    try {
      await performLogin(this.#context, credentials, this.#loginConfig, options);
      this.#context.authenticationState = "valid";
    } catch (error) {
      this.clearSession();
      throw error;
    }
  }

  captureSession(): ProviderSessionSnapshot<typeof YUCHO_DEBIT_PROVIDER_ID> {
    if (this.#context.authenticationState !== "valid" || this.#context.userAgent === "") {
      throw new TypeError("yucho-debit: an unvalidated session cannot be captured");
    }
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      provider: this.provider,
      connectionID: this.connection.id,
      capturedAt: new Date().toISOString(),
      payload: {
        cookies: serializeCookies(this.#context.session.cookies.capture()),
        userAgent: this.#context.userAgent,
      },
    };
  }

  clearSession(): void {
    this.#context.session.cookies.clear();
    this.#context.userAgent = "";
    this.#context.authenticationState = "empty";
  }
}

function serializeCookies(cookies: CookieSnapshot[]): JsonObject[] {
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    hostOnly: cookie.hostOnly,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expiresAt === undefined ? {} : { expiresAt: cookie.expiresAt }),
  }));
}

function rejected(
  reason: Extract<SessionRestoreResult, { status: "rejected" }>["reason"],
): SessionRestoreResult {
  return { status: "rejected", reason };
}

function isValidCapturedAt(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function cookieDomainMatches(baseURL: URL, domain: string): boolean {
  return baseURL.hostname.toLowerCase() === domain;
}

function hasOnlyCookieFields(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const allowed = [
    "name",
    "value",
    "domain",
    "path",
    "hostOnly",
    "secure",
    "httpOnly",
    "expiresAt",
  ] as const;
  return value.every((cookie) => isRecord(cookie) && hasOnlyKeys(cookie, allowed));
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
