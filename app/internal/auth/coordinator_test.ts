import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert/";
import type { AuthInteraction } from "../port/auth_interaction.ts";
import type {
  AuthenticationOptions,
  AuthenticationPort,
  LoginOptions,
  ProviderSessionSnapshot,
  SessionValidation,
} from "../port/authentication.ts";
import type { ProviderID } from "../port/provider.ts";
import type { SessionKey, SessionVaultOptions, SessionVaultPort } from "../port/session_vault.ts";
import { AuthCoordinator } from "./coordinator.ts";

interface TestCredentials {
  readonly password: string;
}

const key: SessionKey = {
  provider: "amazon",
  profile: "default",
};

const storedSnapshot: ProviderSessionSnapshot = {
  schemaVersion: 1,
  provider: "amazon",
  capturedAt: "2026-08-23T00:00:00.000Z",
  payload: { cookie: "old" },
};

const capturedSnapshot: ProviderSessionSnapshot = {
  schemaVersion: 1,
  provider: "amazon",
  capturedAt: "2026-08-23T01:00:00.000Z",
  payload: { cookie: "refreshed" },
};

const interaction: AuthInteraction = {
  otp: {
    request: () => Promise.reject(new Error("OTP was not expected")),
  },
  progress: {
    publish: () => Promise.resolve(),
  },
};

class FakeAuthentication implements AuthenticationPort<TestCredentials> {
  readonly provider: ProviderID;
  readonly events: string[];
  validation: SessionValidation = { status: "valid" };
  loginError?: unknown;
  restoreError?: unknown;
  captured = capturedSnapshot;

  constructor(events: string[], provider: ProviderID = "amazon") {
    this.events = events;
    this.provider = provider;
  }

  restoreSession(_snapshot: unknown): void {
    this.events.push("restore");
    if (this.restoreError !== undefined) throw this.restoreError;
  }

  validateSession(
    _options?: AuthenticationOptions,
  ): Promise<SessionValidation> {
    this.events.push("validate");
    return Promise.resolve(this.validation);
  }

  login(
    _credentials: TestCredentials,
    _options: LoginOptions,
  ): Promise<void> {
    this.events.push("login");
    return this.loginError === undefined ? Promise.resolve() : Promise.reject(this.loginError);
  }

  captureSession(): ProviderSessionSnapshot {
    this.events.push("capture");
    return this.captured;
  }

  clearSession(): void {
    this.events.push("clear");
  }
}

class FakeSessionVault implements SessionVaultPort {
  readonly events: string[];
  loaded: unknown | undefined;
  saveError?: unknown;
  saved?: ProviderSessionSnapshot;

  constructor(events: string[], loaded?: unknown) {
    this.events = events;
    this.loaded = loaded;
  }

  load(
    _key: SessionKey,
    _options?: SessionVaultOptions,
  ): Promise<unknown | undefined> {
    this.events.push("load");
    return Promise.resolve(this.loaded);
  }

  save(
    _key: SessionKey,
    snapshot: ProviderSessionSnapshot,
    _options?: SessionVaultOptions,
  ): Promise<void> {
    this.events.push("save");
    if (this.saveError !== undefined) return Promise.reject(this.saveError);
    this.saved = snapshot;
    return Promise.resolve();
  }

  remove(
    _key: SessionKey,
    _options?: SessionVaultOptions,
  ): Promise<void> {
    this.events.push("remove");
    return Promise.resolve();
  }
}

Deno.test("AuthCoordinator reuses and refreshes a valid saved session", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events, storedSnapshot);
  let credentialsRequested = false;

  const result = await new AuthCoordinator(auth, vault).ensureAuthenticated({
    key,
    interaction,
    getCredentials: () => {
      credentialsRequested = true;
      return Promise.resolve({ password: "secret" });
    },
  });

  assertEquals(result, {
    session: "reused",
    persistence: { status: "saved" },
  });
  assertEquals(credentialsRequested, false);
  assertEquals(events, ["load", "restore", "validate", "capture", "save"]);
  assertStrictEquals(vault.saved, capturedSnapshot);
});

Deno.test("AuthCoordinator logs in lazily when no saved session exists", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events);

  const result = await new AuthCoordinator(auth, vault).ensureAuthenticated({
    key,
    interaction,
    getCredentials: () => {
      events.push("credentials");
      return Promise.resolve({ password: "secret" });
    },
  });

  assertEquals(result, {
    session: "created",
    persistence: { status: "saved" },
  });
  assertEquals(events, ["load", "clear", "credentials", "login", "capture", "save"]);
});

Deno.test("AuthCoordinator replaces an expired session with a new login", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  auth.validation = { status: "expired" };
  const vault = new FakeSessionVault(events, storedSnapshot);

  const result = await new AuthCoordinator(auth, vault).ensureAuthenticated({
    key,
    interaction,
    getCredentials: () => {
      events.push("credentials");
      return Promise.resolve({ password: "secret" });
    },
  });

  assertEquals(result.session, "created");
  assertEquals(events, [
    "load",
    "restore",
    "validate",
    "clear",
    "credentials",
    "login",
    "capture",
    "save",
  ]);
});

Deno.test("AuthCoordinator reports a non-abort save failure without losing authentication", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events);
  const saveError = new Error("disk full");
  vault.saveError = saveError;

  const result = await new AuthCoordinator(auth, vault).ensureAuthenticated({
    key,
    interaction,
    getCredentials: () => Promise.resolve({ password: "secret" }),
  });

  assertEquals(result.session, "created");
  assertEquals(result.persistence.status, "failed");
  if (result.persistence.status === "failed") {
    assertStrictEquals(result.persistence.error, saveError);
  }
});

Deno.test("AuthCoordinator propagates AbortError from session persistence", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events);
  vault.saveError = new DOMException("cancelled", "AbortError");

  await assertRejects(
    () =>
      new AuthCoordinator(auth, vault).ensureAuthenticated({
        key,
        interaction,
        getCredentials: () => Promise.resolve({ password: "secret" }),
      }),
    DOMException,
    "cancelled",
  );
});

Deno.test("AuthCoordinator clears a partially authenticated session after login failure", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events);
  auth.loginError = new Error("rejected");

  await assertRejects(
    () =>
      new AuthCoordinator(auth, vault).ensureAuthenticated({
        key,
        interaction,
        getCredentials: () => Promise.resolve({ password: "secret" }),
      }),
    Error,
    "rejected",
  );

  assertEquals(events, ["load", "clear", "login", "clear"]);
});

Deno.test("AuthCoordinator does not guess how to recover from a restore failure", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events, storedSnapshot);
  auth.restoreError = new Error("unsupported snapshot");

  await assertRejects(
    () =>
      new AuthCoordinator(auth, vault).ensureAuthenticated({
        key,
        interaction,
        getCredentials: () => Promise.resolve({ password: "secret" }),
      }),
    Error,
    "unsupported snapshot",
  );

  assertEquals(events, ["load", "restore"]);
});

Deno.test("AuthCoordinator rejects a provider mismatch before touching the vault", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events, "jcb");
  const vault = new FakeSessionVault(events);

  await assertRejects(
    () =>
      new AuthCoordinator(auth, vault).ensureAuthenticated({
        key,
        interaction,
        getCredentials: () => Promise.resolve({ password: "secret" }),
      }),
    TypeError,
    "does not match",
  );

  assertEquals(events, []);
});

Deno.test("AuthCoordinator rejects a captured snapshot for another provider", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  auth.captured = {
    ...capturedSnapshot,
    provider: "jcb",
  };
  const vault = new FakeSessionVault(events);

  await assertRejects(
    () =>
      new AuthCoordinator(auth, vault).ensureAuthenticated({
        key,
        interaction,
        getCredentials: () => Promise.resolve({ password: "secret" }),
      }),
    TypeError,
    "does not match",
  );

  assertEquals(events, ["load", "clear", "login", "capture"]);
});
