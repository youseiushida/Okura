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
import { JCB_PROVIDER_ID, type JCBContext } from "./context.ts";
import {
  type Credentials,
  type LoginOptions,
  performLogin,
  validateCurrentSession,
} from "./login.ts";

const SNAPSHOT_SCHEMA_VERSION = 1;

export class JCBAuthentication implements AuthenticationPort<typeof JCB_PROVIDER_ID, Credentials> {
  readonly provider = JCB_PROVIDER_ID;
  readonly #context: JCBContext;
  readonly #loginOptions: Omit<LoginOptions, "signal">;

  constructor(context: JCBContext, options: Omit<LoginOptions, "signal"> = {}) {
    this.#context = context;
    this.#loginOptions = options;
  }

  restoreSession(snapshot: unknown): SessionRestoreResult {
    this.clearSession();
    if (!isRecord(snapshot)) return rejected("malformed");
    if (snapshot.provider !== this.provider) return rejected("provider-mismatch");
    if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      return Number.isInteger(snapshot.schemaVersion)
        ? rejected("unsupported-schema")
        : rejected("malformed");
    }
    if (!isValidCapturedAt(snapshot.capturedAt) || !isRecord(snapshot.payload)) {
      return rejected("malformed");
    }
    const userAgent = snapshot.payload.userAgent;
    if (typeof userAgent !== "string" || userAgent === "" || hasControlCharacter(userAgent)) {
      return rejected("malformed");
    }
    try {
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
    await performLogin(this.#context, credentials, {
      ...this.#loginOptions,
      signal: options.signal,
    });
    this.#context.authenticationState = "valid";
  }

  captureSession(): ProviderSessionSnapshot<typeof JCB_PROVIDER_ID> {
    if (this.#context.authenticationState !== "valid" || this.#context.userAgent === "") {
      throw new TypeError("jcb: an unvalidated session cannot be captured");
    }
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      provider: this.provider,
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
  return typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value));
}

function cookieDomainMatches(baseURL: URL, domain: string): boolean {
  const host = baseURL.hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
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
