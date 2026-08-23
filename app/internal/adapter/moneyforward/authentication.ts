import { type CookieSnapshot, parseCookieSnapshot } from "../../http/session.ts";
import type {
  AuthenticationOptions,
  AuthenticationPort,
  JsonObject,
  LoginOptions,
  ProviderSessionSnapshot,
  SessionRestoreResult,
  SessionValidation,
} from "../../port/authentication.ts";
import { MONEYFORWARD_PROVIDER_ID, type MoneyForwardContext } from "./context.ts";
import { type Credentials, performLogin, validateCurrentSession } from "./login.ts";

const SNAPSHOT_SCHEMA_VERSION = 1;

export class MoneyForwardAuthentication
  implements AuthenticationPort<typeof MONEYFORWARD_PROVIDER_ID, Credentials> {
  readonly provider = MONEYFORWARD_PROVIDER_ID;
  readonly connection;
  readonly #context: MoneyForwardContext;

  constructor(context: MoneyForwardContext) {
    this.#context = context;
    this.connection = context.connection;
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
    if (typeof snapshot.connectionID !== "string") return rejected("malformed");
    if (snapshot.connectionID !== this.connection.id) return rejected("connection-mismatch");
    if (!isValidCapturedAt(snapshot.capturedAt) || !isRecord(snapshot.payload)) {
      return rejected("malformed");
    }
    try {
      const cookies = parseCookieSnapshot(snapshot.payload.cookies);
      const allowedDomains = new Set([
        this.#context.baseURL.hostname.toLowerCase(),
        this.#context.idBaseURL.hostname.toLowerCase(),
      ]);
      if (cookies.some((cookie) => !allowedDomains.has(cookie.domain))) {
        return rejected("malformed");
      }
      this.#context.session.cookies.restore(cookies);
    } catch {
      return rejected("malformed");
    }
    this.#context.authenticationState = "restored";
    return { status: "restored" };
  }

  async validateSession(options: AuthenticationOptions = {}): Promise<SessionValidation> {
    if (this.#context.authenticationState !== "restored") return { status: "expired" };
    const valid = await validateCurrentSession(this.#context, options);
    this.#context.authenticationState = valid ? "valid" : "expired";
    return { status: valid ? "valid" : "expired" };
  }

  async login(credentials: Credentials, options: LoginOptions): Promise<void> {
    this.clearSession();
    await performLogin(this.#context, credentials, options);
    this.#context.authenticationState = "valid";
  }

  captureSession(): ProviderSessionSnapshot<typeof MONEYFORWARD_PROVIDER_ID> {
    if (this.#context.authenticationState !== "valid") {
      throw new TypeError("moneyforward: an unvalidated session cannot be captured");
    }
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      provider: this.provider,
      connectionID: this.connection.id,
      capturedAt: new Date().toISOString(),
      payload: { cookies: serializeCookies(this.#context.session.cookies.capture()) },
    };
  }

  clearSession(): void {
    this.#context.session.cookies.clear();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
