import { join } from "node:path";
import { createProviderConnection } from "../../model/connection.ts";
import type { ProviderSessionSnapshot } from "../../port/authentication.ts";
import { isProviderID, type ProviderID } from "../../port/provider.ts";
import type {
  SessionKey,
  SessionVaultOptions,
  SessionVaultPort,
} from "../../port/session_vault.ts";

const MAX_ENCRYPTED_BYTES = 4 << 20;
const MAX_PLAINTEXT_BYTES = 2 << 20;

export interface DataProtector {
  protect(value: Uint8Array, options?: SessionVaultOptions): Promise<Uint8Array>;
  unprotect(value: Uint8Array, options?: SessionVaultOptions): Promise<Uint8Array>;
}

/**
 * snapshotをProvider/profileごとの暗号化ファイルへ保存する。
 * 暗号方式そのものはDataProtectorへ委譲する。
 */
export class FileSessionVault implements SessionVaultPort {
  readonly #root: string;
  readonly #protector: DataProtector;

  constructor(root: string, protector: DataProtector) {
    if (root.trim() === "") throw new TypeError("session vault root is required");
    this.#root = root;
    this.#protector = protector;
  }

  async load<Provider extends ProviderID>(
    key: SessionKey<Provider>,
    options: SessionVaultOptions = {},
  ): Promise<unknown | undefined> {
    options.signal?.throwIfAborted();
    const path = await this.#path(key);
    let encrypted: Uint8Array;
    try {
      const info = await Deno.stat(path);
      if (!info.isFile) throw new Error("session vault entry is not a file");
      if (info.size > MAX_ENCRYPTED_BYTES) throw new Error("session vault entry is too large");
      encrypted = await Deno.readFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    options.signal?.throwIfAborted();
    if (encrypted.byteLength > MAX_ENCRYPTED_BYTES) {
      throw new Error("session vault entry is too large");
    }
    const plaintext = await this.#protector.unprotect(encrypted, options);
    options.signal?.throwIfAborted();
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new Error("decrypted session vault entry is too large");
    }
    try {
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (error) {
      throw new Error("decrypted session vault entry is not valid JSON", { cause: error });
    }
  }

  async save<Provider extends ProviderID>(
    key: SessionKey<Provider>,
    snapshot: ProviderSessionSnapshot<Provider>,
    options: SessionVaultOptions = {},
  ): Promise<void> {
    validateKey(key);
    if (snapshot.provider !== key.provider) {
      throw new TypeError("session key and snapshot provider do not match");
    }
    if (snapshot.connectionID !== key.id) {
      throw new TypeError("session key and snapshot connection do not match");
    }
    options.signal?.throwIfAborted();
    const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new Error("session snapshot is too large");
    }
    const encrypted = await this.#protector.protect(plaintext, options);
    options.signal?.throwIfAborted();
    if (encrypted.byteLength > MAX_ENCRYPTED_BYTES) {
      throw new Error("encrypted session snapshot is too large");
    }

    const path = await this.#path(key);
    await Deno.mkdir(this.#root, { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeFile(temporary, encrypted, { createNew: true });
      options.signal?.throwIfAborted();
      await Deno.rename(temporary, path);
    } finally {
      try {
        await Deno.remove(temporary);
      } catch {
        // Best effort: do not replace the save result with a temp cleanup error.
      }
    }
  }

  async remove<Provider extends ProviderID>(
    key: SessionKey<Provider>,
    options: SessionVaultOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const path = await this.#path(key);
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  async #path<Provider extends ProviderID>(key: SessionKey<Provider>): Promise<string> {
    validateKey(key);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${key.provider}\u0000${key.profile}`),
    );
    const suffix = toHex(new Uint8Array(digest)).slice(0, 32);
    return join(this.#root, `${key.provider}-${suffix}.session`);
  }
}

function validateKey(key: SessionKey): void {
  if (!isProviderID(key.provider)) throw new TypeError("invalid session provider");
  if (
    typeof key.profile !== "string" || key.profile.trim() === "" || key.profile.length > 200 ||
    hasControlCharacter(key.profile)
  ) {
    throw new TypeError("invalid session profile");
  }
  if (key.id !== createProviderConnection(key.provider, key.profile).id) {
    throw new TypeError("invalid session connection ID");
  }
}

function toHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
