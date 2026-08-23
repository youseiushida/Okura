import { createProviderConnection, type ProviderConnection } from "../model/connection.ts";
import type {
  AuthenticationOptions,
  AuthenticationPort,
  LoginOptions,
  ProviderSessionSnapshot,
  SessionRestoreResult,
  SessionValidation,
} from "../port/authentication.ts";
import type { ProviderID } from "../port/provider.ts";
import type {
  CredentialKey,
  CredentialVaultOptions,
  CredentialVaultPort,
  StoredPasswordCredential,
} from "../port/credential_vault.ts";
import type { SessionKey, SessionVaultOptions, SessionVaultPort } from "../port/session_vault.ts";

export class FakeAuthentication<Provider extends ProviderID, Credentials>
  implements AuthenticationPort<Provider, Credentials> {
  readonly provider: Provider;
  readonly connection: ProviderConnection<Provider>;
  validation: SessionValidation = { status: "valid" };
  restoreResult: SessionRestoreResult = { status: "restored" };
  loginHandler: (credentials: Credentials, options: LoginOptions) => Promise<void> = () =>
    Promise.resolve();
  loginCount = 0;
  valid = false;

  constructor(provider: Provider, profile = "default") {
    this.provider = provider;
    this.connection = createProviderConnection(provider, profile);
  }

  restoreSession(_snapshot: unknown): SessionRestoreResult {
    this.valid = false;
    return this.restoreResult;
  }

  validateSession(_options?: AuthenticationOptions): Promise<SessionValidation> {
    this.valid = this.validation.status === "valid";
    return Promise.resolve(this.validation);
  }

  async login(credentials: Credentials, options: LoginOptions): Promise<void> {
    this.loginCount += 1;
    await this.loginHandler(credentials, options);
    this.valid = true;
  }

  captureSession(): ProviderSessionSnapshot<Provider> {
    if (!this.valid) throw new Error("not authenticated");
    return {
      schemaVersion: 1,
      provider: this.provider,
      connectionID: this.connection.id,
      capturedAt: "2026-08-23T00:00:00.000Z",
      payload: {},
    };
  }

  clearSession(): void {
    this.valid = false;
  }
}

export class FakeSessionVault implements SessionVaultPort {
  loaded: unknown | undefined;
  saved?: ProviderSessionSnapshot;
  removed?: SessionKey;

  load<Provider extends ProviderID>(
    _key: SessionKey<Provider>,
    _options?: SessionVaultOptions,
  ): Promise<unknown | undefined> {
    return Promise.resolve(this.loaded);
  }

  save<Provider extends ProviderID>(
    _key: SessionKey<Provider>,
    snapshot: ProviderSessionSnapshot<Provider>,
    _options?: SessionVaultOptions,
  ): Promise<void> {
    this.saved = snapshot;
    this.loaded = snapshot;
    return Promise.resolve();
  }

  remove<Provider extends ProviderID>(
    key: SessionKey<Provider>,
    _options?: SessionVaultOptions,
  ): Promise<void> {
    this.removed = key;
    this.loaded = undefined;
    return Promise.resolve();
  }
}

export class FakeCredentialVault implements CredentialVaultPort {
  readonly events?: string[];
  loaded: unknown | undefined;
  saved?: StoredPasswordCredential;
  removed?: CredentialKey;
  loadError?: unknown;
  saveError?: unknown;
  loadCount = 0;
  saveCount = 0;
  removeCount = 0;

  constructor(events?: string[]) {
    this.events = events;
  }

  load<Provider extends ProviderID>(
    _key: CredentialKey<Provider>,
    _options?: CredentialVaultOptions,
  ): Promise<unknown | undefined> {
    this.loadCount += 1;
    this.events?.push("credential-load");
    return this.loadError === undefined
      ? Promise.resolve(this.loaded)
      : Promise.reject(this.loadError);
  }

  save<Provider extends ProviderID>(
    _key: CredentialKey<Provider>,
    credential: StoredPasswordCredential<Provider>,
    _options?: CredentialVaultOptions,
  ): Promise<void> {
    this.saveCount += 1;
    this.events?.push("credential-save");
    if (this.saveError !== undefined) return Promise.reject(this.saveError);
    this.saved = credential;
    this.loaded = credential;
    return Promise.resolve();
  }

  remove<Provider extends ProviderID>(
    key: CredentialKey<Provider>,
    _options?: CredentialVaultOptions,
  ): Promise<void> {
    this.removeCount += 1;
    this.events?.push("credential-remove");
    this.removed = key;
    this.loaded = undefined;
    return Promise.resolve();
  }
}
