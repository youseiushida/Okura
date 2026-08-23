import type {
  CredentialKey,
  CredentialVaultOptions,
  CredentialVaultPort,
  StoredPasswordCredential,
} from "../../port/credential_vault.ts";
import type { ProviderID } from "../../port/provider.ts";
import type { SecretStorePort } from "../../port/secret_store.ts";

const CREDENTIAL_SERVICE = "Okura credentials v1";
const MAX_SECRET_BYTES = 16 << 10;
const encoder = new TextEncoder();

export class KeyringCredentialVault implements CredentialVaultPort {
  readonly #backend: SecretStorePort;
  readonly #service: string;

  constructor(backend: SecretStorePort, service = CREDENTIAL_SERVICE) {
    if (service.trim() === "") throw new TypeError("credential service is required");
    this.#backend = backend;
    this.#service = service;
  }

  async load<Provider extends ProviderID>(
    key: CredentialKey<Provider>,
    options: CredentialVaultOptions = {},
  ): Promise<unknown | undefined> {
    options.signal?.throwIfAborted();
    const serialized = await this.#backend.get(this.#service, key.id, options);
    options.signal?.throwIfAborted();
    if (serialized === undefined) return undefined;
    if (encoder.encode(serialized).byteLength > MAX_SECRET_BYTES) {
      throw new Error("saved credentials are too large");
    }
    try {
      return JSON.parse(serialized);
    } catch (error) {
      throw new Error("saved credentials are not valid JSON", { cause: error });
    }
  }

  async save<Provider extends ProviderID>(
    key: CredentialKey<Provider>,
    credential: StoredPasswordCredential<Provider>,
    options: CredentialVaultOptions = {},
  ): Promise<void> {
    if (credential.provider !== key.provider) {
      throw new TypeError("credential key and provider do not match");
    }
    if (credential.connectionID !== key.id) {
      throw new TypeError("credential key and connection do not match");
    }
    const serialized = JSON.stringify(credential);
    if (encoder.encode(serialized).byteLength > MAX_SECRET_BYTES) {
      throw new Error("credentials are too large for the OS credential store");
    }
    options.signal?.throwIfAborted();
    await this.#backend.set(this.#service, key.id, serialized, options);
    options.signal?.throwIfAborted();
  }

  async remove<Provider extends ProviderID>(
    key: CredentialKey<Provider>,
    options: CredentialVaultOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    await this.#backend.remove(this.#service, key.id, options);
    options.signal?.throwIfAborted();
  }
}
