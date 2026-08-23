import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert/";
import type { AuthInteraction } from "../port/auth_interaction.ts";
import { createProviderConnection, type ProviderConnection } from "../model/connection.ts";
import { PrimaryCredentialRejectedError } from "../port/authentication.ts";
import type {
  AuthenticationOptions,
  AuthenticationPort,
  LoginOptions,
  ProviderSessionSnapshot,
  SessionRestoreResult,
  SessionValidation,
} from "../port/authentication.ts";
import type { ProviderID } from "../port/provider.ts";
import type { CredentialInput } from "./credentials.ts";
import type { SessionKey, SessionVaultOptions, SessionVaultPort } from "../port/session_vault.ts";
import { FakeCredentialVault } from "../testing/authentication.ts";
import { SavedCredentialLoginError, storedPasswordCredential } from "./credentials.ts";
import { AuthCoordinator } from "./authentication.ts";

interface TestCredentials {
  readonly password: string;
}

const key: SessionKey = createProviderConnection("amazon", "default");

const storedSnapshot: ProviderSessionSnapshot = {
  schemaVersion: 1,
  provider: "amazon",
  connectionID: key.id,
  capturedAt: "2026-08-23T00:00:00.000Z",
  payload: { cookie: "old" },
};

const capturedSnapshot: ProviderSessionSnapshot = {
  schemaVersion: 1,
  provider: "amazon",
  connectionID: key.id,
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

class FakeAuthentication implements AuthenticationPort<ProviderID, TestCredentials> {
  readonly provider: ProviderID;
  readonly connection: ProviderConnection;
  readonly events: string[];
  validation: SessionValidation = { status: "valid" };
  loginError?: unknown;
  loginHandler?: (credentials: TestCredentials, options: LoginOptions) => Promise<void>;
  restoreResult: SessionRestoreResult = { status: "restored" };
  captured = capturedSnapshot;

  constructor(events: string[], provider: ProviderID = "amazon") {
    this.events = events;
    this.provider = provider;
    this.connection = createProviderConnection(provider, "default");
  }

  restoreSession(_snapshot: unknown): SessionRestoreResult {
    this.events.push("restore");
    return this.restoreResult;
  }

  validateSession(
    _options?: AuthenticationOptions,
  ): Promise<SessionValidation> {
    this.events.push("validate");
    return Promise.resolve(this.validation);
  }

  async login(
    credentials: TestCredentials,
    options: LoginOptions,
  ): Promise<void> {
    this.events.push("login");
    if (this.loginError !== undefined) throw this.loginError;
    await this.loginHandler?.(credentials, options);
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

  load<Provider extends ProviderID>(
    _key: SessionKey<Provider>,
    _options?: SessionVaultOptions,
  ): Promise<unknown | undefined> {
    this.events.push("load");
    return Promise.resolve(this.loaded);
  }

  save<Provider extends ProviderID>(
    _key: SessionKey<Provider>,
    snapshot: ProviderSessionSnapshot<Provider>,
    _options?: SessionVaultOptions,
  ): Promise<void> {
    this.events.push("save");
    if (this.saveError !== undefined) return Promise.reject(this.saveError);
    this.saved = snapshot;
    return Promise.resolve();
  }

  remove<Provider extends ProviderID>(
    _key: SessionKey<Provider>,
    _options?: SessionVaultOptions,
  ): Promise<void> {
    this.events.push("remove");
    return Promise.resolve();
  }
}

function coordinator(
  auth: FakeAuthentication,
  vault: FakeSessionVault,
  credentialVault = new FakeCredentialVault(),
): AuthCoordinator<ProviderID, TestCredentials> {
  return new AuthCoordinator(auth, vault, credentialVault);
}

function credentialInput(
  get: () => Promise<TestCredentials>,
): CredentialInput<ProviderID, TestCredentials> {
  return {
    readEnvironment: () => Promise.resolve(undefined),
    prompt: get,
    fromStored: (stored) => ({ password: stored.password }),
    toStored: (connection, credentials) =>
      storedPasswordCredential(connection, "test-user", credentials.password),
  };
}

Deno.test("AuthCoordinator reuses and refreshes a valid saved session", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events, storedSnapshot);
  let credentialsRequested = false;

  const result = await coordinator(auth, vault).ensureAuthenticated({
    key,
    interaction,
    credentialInput: credentialInput(() => {
      credentialsRequested = true;
      return Promise.resolve({ password: "secret" });
    }),
  });

  assertEquals(result, {
    session: "reused",
    persistence: { status: "saved" },
    credentials: {
      status: "not-required",
      persistence: { status: "not-requested" },
    },
  });
  assertEquals(credentialsRequested, false);
  assertEquals(events, ["load", "restore", "validate", "capture", "save"]);
  assertStrictEquals(vault.saved, capturedSnapshot);
});

Deno.test("AuthCoordinator logs in lazily when no saved session exists", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events);

  const result = await coordinator(auth, vault).ensureAuthenticated({
    key,
    interaction,
    credentialInput: credentialInput(() => {
      events.push("credentials");
      return Promise.resolve({ password: "secret" });
    }),
  });

  assertEquals(result, {
    session: "created",
    persistence: { status: "saved" },
    credentials: {
      status: "used",
      source: "interactive",
      persistence: { status: "not-requested" },
    },
  });
  assertEquals(events, ["load", "clear", "credentials", "login", "capture", "save"]);
});

Deno.test("AuthCoordinator force reauthentication removes and ignores a saved session", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events, storedSnapshot);

  const result = await coordinator(auth, vault).ensureAuthenticated({
    key,
    interaction,
    forceReauthentication: true,
    credentialInput: credentialInput(() => Promise.resolve({ password: "new-secret" })),
  });

  assertEquals(result.session, "created");
  assertEquals(events, ["remove", "clear", "login", "capture", "save"]);
});

Deno.test("AuthCoordinator replaces an expired session with a new login", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  auth.validation = { status: "expired" };
  const vault = new FakeSessionVault(events, storedSnapshot);

  const result = await coordinator(auth, vault).ensureAuthenticated({
    key,
    interaction,
    credentialInput: credentialInput(() => {
      events.push("credentials");
      return Promise.resolve({ password: "secret" });
    }),
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

  const result = await coordinator(auth, vault).ensureAuthenticated({
    key,
    interaction,
    credentialInput: credentialInput(() => Promise.resolve({ password: "secret" })),
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
      coordinator(auth, vault).ensureAuthenticated({
        key,
        interaction,
        credentialInput: credentialInput(() => Promise.resolve({ password: "secret" })),
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
      coordinator(auth, vault).ensureAuthenticated({
        key,
        interaction,
        credentialInput: credentialInput(() => Promise.resolve({ password: "secret" })),
      }),
    Error,
    "rejected",
  );

  assertEquals(events, ["load", "clear", "login", "clear"]);
});

Deno.test("AuthCoordinator removes a malformed snapshot and logs in again", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events, storedSnapshot);
  auth.restoreResult = { status: "rejected", reason: "unsupported-schema" };

  const result = await coordinator(auth, vault).ensureAuthenticated({
    key,
    interaction,
    credentialInput: credentialInput(() => Promise.resolve({ password: "secret" })),
  });

  assertEquals(result.recovery, {
    reason: "unsupported-schema",
    storedSnapshot: "removed",
  });
  assertEquals(events, ["load", "restore", "remove", "clear", "login", "capture", "save"]);
});

Deno.test("AuthCoordinator can replace a malformed snapshot only after login", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events, storedSnapshot);
  auth.restoreResult = { status: "rejected", reason: "malformed" };

  const result = await coordinator(auth, vault).ensureAuthenticated({
    key,
    interaction,
    invalidSessionRecovery: "replace",
    credentialInput: credentialInput(() => Promise.resolve({ password: "secret" })),
  });

  assertEquals(result.recovery, {
    reason: "malformed",
    storedSnapshot: "replaced",
  });
  assertEquals(events, ["load", "restore", "clear", "login", "capture", "save"]);
});

Deno.test("AuthCoordinator reports a malformed snapshot as retained when replacement save fails", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events, storedSnapshot);
  auth.restoreResult = { status: "rejected", reason: "malformed" };
  vault.saveError = new Error("disk full");

  const result = await coordinator(auth, vault).ensureAuthenticated({
    key,
    interaction,
    invalidSessionRecovery: "replace",
    credentialInput: credentialInput(() => Promise.resolve({ password: "secret" })),
  });

  assertEquals(result.recovery, {
    reason: "malformed",
    storedSnapshot: "retained",
  });
  assertEquals(result.persistence.status, "failed");
});

Deno.test("AuthCoordinator rejects a provider mismatch before touching the vault", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events, "jcb");
  const vault = new FakeSessionVault(events);

  await assertRejects(
    () =>
      coordinator(auth, vault).ensureAuthenticated({
        key,
        interaction,
        credentialInput: credentialInput(() => Promise.resolve({ password: "secret" })),
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
      coordinator(auth, vault).ensureAuthenticated({
        key,
        interaction,
        credentialInput: credentialInput(() => Promise.resolve({ password: "secret" })),
      }),
    TypeError,
    "does not match",
  );

  assertEquals(events, ["load", "clear", "login", "capture"]);
});

Deno.test("AuthCoordinator skips credential persistence when a saved session is reused", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events, storedSnapshot);
  const credentialVault = new FakeCredentialVault(events);

  const result = await coordinator(auth, vault, credentialVault).ensureAuthenticated({
    key,
    interaction,
    saveCredentials: true,
    credentialInput: credentialInput(() => Promise.reject(new Error("credentials not expected"))),
  });

  assertEquals(result.credentials, {
    status: "not-required",
    persistence: { status: "skipped", reason: "session-reused" },
  });
  assertEquals(credentialVault.loadCount, 0);
  assertEquals(credentialVault.saveCount, 0);
});

Deno.test("AuthCoordinator saves static credentials only after successful login", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events);
  const credentialVault = new FakeCredentialVault(events);

  const result = await coordinator(auth, vault, credentialVault).ensureAuthenticated({
    key,
    interaction,
    saveCredentials: true,
    credentialInput: credentialInput(() => {
      events.push("credentials");
      return Promise.resolve({ password: "test-password" });
    }),
  });

  assertEquals(result.credentials, {
    status: "used",
    source: "interactive",
    persistence: { status: "saved" },
  });
  assertEquals(events, [
    "load",
    "clear",
    "credential-load",
    "credentials",
    "login",
    "capture",
    "save",
    "credential-save",
  ]);
  assertEquals(credentialVault.saved, storedPasswordCredential(key, "test-user", "test-password"));
});

Deno.test("AuthCoordinator never saves credentials when login fails", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  auth.loginError = new Error("rejected");
  const vault = new FakeSessionVault(events);
  const credentialVault = new FakeCredentialVault(events);

  await assertRejects(
    () =>
      coordinator(auth, vault, credentialVault).ensureAuthenticated({
        key,
        interaction,
        saveCredentials: true,
        credentialInput: credentialInput(() => Promise.resolve({ password: "test-password" })),
      }),
    Error,
    "rejected",
  );

  assertEquals(credentialVault.saveCount, 0);
});

Deno.test("AuthCoordinator retains a saved credential after authentication rejection", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  auth.loginError = new PrimaryCredentialRejectedError("amazon", "rejected");
  const vault = new FakeSessionVault(events);
  const credentialVault = new FakeCredentialVault(events);
  credentialVault.loaded = storedPasswordCredential(key, "saved-user", "saved-password");

  await assertRejects(
    () =>
      coordinator(auth, vault, credentialVault).ensureAuthenticated({
        key,
        interaction,
        credentialInput: credentialInput(() => Promise.reject(new Error("prompt not expected"))),
      }),
    SavedCredentialLoginError,
    "credentials were retained",
  );

  assertEquals(credentialVault.removeCount, 0);
  assertEquals(
    credentialVault.loaded,
    storedPasswordCredential(key, "saved-user", "saved-password"),
  );
});

Deno.test("AuthCoordinator preserves a non-credential failure from saved credential login", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const failure = new Error("network unavailable");
  auth.loginError = failure;
  const credentialVault = new FakeCredentialVault(events);
  credentialVault.loaded = storedPasswordCredential(key, "saved-user", "saved-password");

  let caught: unknown;
  try {
    await coordinator(auth, new FakeSessionVault(events), credentialVault).ensureAuthenticated({
      key,
      interaction,
      credentialInput: credentialInput(() => Promise.reject(new Error("prompt not expected"))),
    });
  } catch (error) {
    caught = error;
  }

  assertStrictEquals(caught, failure);
  assertEquals(credentialVault.removeCount, 0);
});

Deno.test("AuthCoordinator preserves an arbitrary abort reason during saved credential login", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const controller = new AbortController();
  const reason = { kind: "cancelled-by-caller" };
  auth.loginHandler = () => {
    controller.abort(reason);
    return Promise.reject(new Error("provider observed cancellation"));
  };
  const credentialVault = new FakeCredentialVault(events);
  credentialVault.loaded = storedPasswordCredential(key, "saved-user", "saved-password");

  let caught: unknown;
  try {
    await coordinator(auth, new FakeSessionVault(events), credentialVault).ensureAuthenticated({
      key,
      interaction,
      signal: controller.signal,
      credentialInput: credentialInput(() => Promise.reject(new Error("prompt not expected"))),
    });
  } catch (error) {
    caught = error;
  }

  assertStrictEquals(caught, reason);
  assertEquals(credentialVault.removeCount, 0);
});

Deno.test("AuthCoordinator does not persist an OTP when credential saving is enabled", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events);
  const credentialVault = new FakeCredentialVault(events);
  const oneTimePassword = "123456";
  auth.loginHandler = async (_credentials, options) => {
    assertEquals(
      await options.interaction.otp.request({
        provider: "amazon",
        step: "test-otp",
        attempt: 1,
        channel: "email",
        format: "numeric",
        resend: { allowed: false },
      }),
      { action: "submit", code: oneTimePassword },
    );
  };

  await coordinator(auth, vault, credentialVault).ensureAuthenticated({
    key,
    saveCredentials: true,
    interaction: {
      ...interaction,
      otp: {
        request: () => Promise.resolve({ action: "submit", code: oneTimePassword }),
      },
    },
    credentialInput: credentialInput(() => Promise.resolve({ password: "static-password" })),
  });

  assertEquals(JSON.stringify(credentialVault.saved).includes(oneTimePassword), false);
  assertEquals(JSON.stringify(vault.saved).includes(oneTimePassword), false);
});

Deno.test("AuthCoordinator does not save credentials when OTP input is aborted", async () => {
  const events: string[] = [];
  const auth = new FakeAuthentication(events);
  const vault = new FakeSessionVault(events);
  const credentialVault = new FakeCredentialVault(events);
  auth.loginHandler = async (_credentials, options) => {
    await options.interaction.otp.request({
      provider: "amazon",
      step: "test-otp",
      attempt: 1,
      channel: "email",
      format: "numeric",
      resend: { allowed: false },
    });
  };

  await assertRejects(
    () =>
      coordinator(auth, vault, credentialVault).ensureAuthenticated({
        key,
        saveCredentials: true,
        interaction: {
          ...interaction,
          otp: {
            request: () => Promise.reject(new DOMException("cancelled", "AbortError")),
          },
        },
        credentialInput: credentialInput(() => Promise.resolve({ password: "static-password" })),
      }),
    DOMException,
    "cancelled",
  );

  assertEquals(credentialVault.saveCount, 0);
});
