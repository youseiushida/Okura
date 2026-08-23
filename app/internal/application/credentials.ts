import type { ProviderConnection } from "../model/connection.ts";
import type {
  CredentialVaultOptions,
  CredentialVaultPort,
  StoredPasswordCredential,
} from "../port/credential_vault.ts";
import type { AuthenticationOptions } from "../port/authentication.ts";
import type { ProviderID } from "../port/provider.ts";

const MAX_IDENTIFIER_LENGTH = 1_024;
const MAX_PASSWORD_LENGTH = 8_192;
const MAX_SERIALIZED_BYTES = 16 << 10;

export type CredentialSource = "environment" | "keyring" | "interactive";

export interface CredentialInput<Provider extends ProviderID, Credentials> {
  /**
   * 関連する環境変数が1つも設定されていない場合はundefinedを返す。
   * 一部だけ設定されている場合、不足項目を対話入力で補ってよい。
   */
  readEnvironment(
    options?: AuthenticationOptions,
  ): Promise<Credentials | undefined>;

  prompt(options?: AuthenticationOptions): Promise<Credentials>;

  fromStored(
    credential: StoredPasswordCredential<Provider>,
  ): Credentials;

  toStored(
    key: ProviderConnection<Provider>,
    credentials: Credentials,
  ): StoredPasswordCredential<Provider>;
}

export interface AcquiredCredentials<Provider extends ProviderID, Credentials> {
  readonly value: Credentials;
  readonly stored: StoredPasswordCredential<Provider>;
  readonly source: CredentialSource;
}

export type CredentialPersistence =
  | { readonly status: "not-requested" }
  | { readonly status: "skipped"; readonly reason: "session-reused" }
  | { readonly status: "saved" }
  | { readonly status: "failed"; readonly error: unknown };

export class SavedCredentialLoginError extends Error {
  override name = "SavedCredentialLoginError";

  constructor(provider: ProviderID, options?: ErrorOptions) {
    super(
      `${provider}: authentication using saved credentials failed; ` +
        `the saved credentials were retained. Run "${provider} credentials remove" ` +
        "before entering replacements.",
      options,
    );
  }
}

/** 環境変数、OS keyring、対話入力の優先順位を調停する。 */
export class CredentialCoordinator<Provider extends ProviderID, Credentials> {
  readonly #vault: CredentialVaultPort;
  readonly #input: CredentialInput<Provider, Credentials>;

  constructor(
    vault: CredentialVaultPort,
    input: CredentialInput<Provider, Credentials>,
  ) {
    this.#vault = vault;
    this.#input = input;
  }

  async acquire(
    key: ProviderConnection<Provider>,
    options: AuthenticationOptions = {},
  ): Promise<AcquiredCredentials<Provider, Credentials>> {
    options.signal?.throwIfAborted();
    const environment = await this.#input.readEnvironment(options);
    options.signal?.throwIfAborted();
    if (environment !== undefined) {
      return this.#acquired(key, environment, "environment");
    }

    const saved = await this.#vault.load(key, options);
    options.signal?.throwIfAborted();
    if (saved !== undefined) {
      const stored = parseStoredPasswordCredential(saved, key);
      return {
        value: this.#input.fromStored(stored),
        stored,
        source: "keyring",
      };
    }

    const interactive = await this.#input.prompt(options);
    options.signal?.throwIfAborted();
    return this.#acquired(key, interactive, "interactive");
  }

  async save(
    key: ProviderConnection<Provider>,
    acquired: AcquiredCredentials<Provider, Credentials>,
    options: CredentialVaultOptions = {},
  ): Promise<CredentialPersistence> {
    options.signal?.throwIfAborted();
    const stored = parseStoredPasswordCredential(acquired.stored, key);
    try {
      await this.#vault.save(key, stored, options);
      options.signal?.throwIfAborted();
      return { status: "saved" };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (isAbortError(error)) throw error;
      return { status: "failed", error };
    }
  }

  #acquired(
    key: ProviderConnection<Provider>,
    value: Credentials,
    source: CredentialSource,
  ): AcquiredCredentials<Provider, Credentials> {
    const stored = parseStoredPasswordCredential(this.#input.toStored(key, value), key);
    return { value, stored, source };
  }
}

export function storedPasswordCredential<Provider extends ProviderID>(
  key: ProviderConnection<Provider>,
  identifier: string,
  password: string,
): StoredPasswordCredential<Provider> {
  return parseStoredPasswordCredential(
    {
      schemaVersion: 1,
      provider: key.provider,
      connectionID: key.id,
      identifier,
      password,
    },
    key,
  );
}

export function parseStoredPasswordCredential<Provider extends ProviderID>(
  value: unknown,
  key: ProviderConnection<Provider>,
): StoredPasswordCredential<Provider> {
  if (!isRecord(value)) throw new TypeError("saved credentials are malformed");
  if (
    !hasExactKeys(value, ["schemaVersion", "provider", "connectionID", "identifier", "password"])
  ) {
    throw new TypeError("saved credentials contain unsupported fields");
  }
  if (value.schemaVersion !== 1) {
    throw new TypeError("saved credentials use an unsupported schema");
  }
  if (value.provider !== key.provider) {
    throw new TypeError("saved credentials belong to another provider");
  }
  if (value.connectionID !== key.id) {
    throw new TypeError("saved credentials belong to another connection");
  }
  if (
    typeof value.identifier !== "string" || value.identifier.trim() === "" ||
    value.identifier !== value.identifier.trim() ||
    value.identifier.length > MAX_IDENTIFIER_LENGTH || hasControlCharacter(value.identifier)
  ) {
    throw new TypeError("saved credential identifier is invalid");
  }
  if (
    typeof value.password !== "string" || value.password === "" ||
    value.password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new TypeError("saved credential password is invalid");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_SERIALIZED_BYTES) {
    throw new TypeError("saved credentials are too large");
  }
  return {
    schemaVersion: 1,
    provider: key.provider,
    connectionID: key.id,
    identifier: value.identifier,
    password: value.password,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
