import { join } from "node:path";
import type { SecretStorePort } from "../../port/secret_store.ts";
import type { SessionVaultOptions } from "../../port/session_vault.ts";
import type { DataProtector } from "./file_vault.ts";

const ENVELOPE_PREFIX = new Uint8Array([0x4f, 0x4b, 0x55, 0x52, 0x41, 0x00, 0x01]);
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const ADDITIONAL_DATA = new TextEncoder().encode("Okura session vault v1");
const MASTER_KEY_SERVICE = "Okura session encryption key v1";
const MASTER_KEY_ACCOUNT = "default";
const MASTER_KEY_BYTES = 32;
const MAX_MASTER_KEY_SECRET_BYTES = 1 << 10;

interface StoredMasterKey {
  readonly schemaVersion: 1;
  readonly algorithm: "AES-256-GCM";
  readonly key: string;
}

/** OS secret storeに保持するAES-256 master keyを初期化・取得する。 */
export class KeyringMasterKeyProvider {
  readonly #store: SecretStorePort;
  readonly #lockRoot: string;
  readonly #service: string;
  readonly #account: string;

  constructor(
    store: SecretStorePort,
    lockRoot: string,
    service = MASTER_KEY_SERVICE,
    account = MASTER_KEY_ACCOUNT,
  ) {
    if (lockRoot.trim() === "") throw new TypeError("master key lock root is required");
    if (service.trim() === "") throw new TypeError("master key service is required");
    if (account.trim() === "") throw new TypeError("master key account is required");
    this.#store = store;
    this.#lockRoot = lockRoot;
    this.#service = service;
    this.#account = account;
  }

  async get(options: SessionVaultOptions = {}): Promise<CryptoKey> {
    options.signal?.throwIfAborted();
    const existing = await this.#store.get(this.#service, this.#account, options);
    options.signal?.throwIfAborted();
    if (existing !== undefined) return importMasterKey(existing);

    await Deno.mkdir(this.#lockRoot, { recursive: true });
    const lockPath = join(this.#lockRoot, ".master-key.lock");
    const lock = await Deno.open(lockPath, { create: true, read: true, write: true });
    let locked = false;
    try {
      await acquireExclusiveLock(lock, options.signal);
      locked = true;
      options.signal?.throwIfAborted();

      const initialized = await this.#store.get(this.#service, this.#account, options);
      if (initialized !== undefined) return importMasterKey(initialized);

      const raw = crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES));
      await this.#store.set(
        this.#service,
        this.#account,
        serializeMasterKey(raw),
        options,
      );
      options.signal?.throwIfAborted();
      const persisted = await this.#store.get(this.#service, this.#account, options);
      if (persisted === undefined) {
        throw new Error("OS credential store did not persist the session encryption key");
      }
      return importMasterKey(persisted);
    } finally {
      if (locked) {
        try {
          await lock.unlock();
        } catch {
          // 主処理またはabort理由を優先する。
        }
      }
      try {
        lock.close();
      } catch {
        // abort待機中にclose済みの場合がある。
      }
    }
  }
}

/** session snapshotをkeyring由来の鍵でAES-256-GCM暗号化する。 */
export class AesGcmDataProtector implements DataProtector {
  readonly #masterKey: KeyringMasterKeyProvider;

  constructor(masterKey: KeyringMasterKeyProvider) {
    this.#masterKey = masterKey;
  }

  async protect(
    value: Uint8Array,
    options: SessionVaultOptions = {},
  ): Promise<Uint8Array> {
    options.signal?.throwIfAborted();
    const key = await this.#masterKey.get(options);
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: ADDITIONAL_DATA, tagLength: 128 },
        key,
        ownedBytes(value),
      ),
    );
    options.signal?.throwIfAborted();
    const envelope = new Uint8Array(
      ENVELOPE_PREFIX.byteLength + iv.byteLength + encrypted.byteLength,
    );
    envelope.set(ENVELOPE_PREFIX, 0);
    envelope.set(iv, ENVELOPE_PREFIX.byteLength);
    envelope.set(encrypted, ENVELOPE_PREFIX.byteLength + iv.byteLength);
    return envelope;
  }

  async unprotect(
    value: Uint8Array,
    options: SessionVaultOptions = {},
  ): Promise<Uint8Array> {
    options.signal?.throwIfAborted();
    const minimum = ENVELOPE_PREFIX.byteLength + AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES;
    if (value.byteLength < minimum || !startsWith(value, ENVELOPE_PREFIX)) {
      throw new Error("session vault entry uses an unsupported encryption envelope");
    }
    const key = await this.#masterKey.get(options);
    const ivStart = ENVELOPE_PREFIX.byteLength;
    const iv = value.slice(ivStart, ivStart + AES_GCM_IV_BYTES);
    const ciphertext = value.slice(ivStart + AES_GCM_IV_BYTES);
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: ADDITIONAL_DATA, tagLength: 128 },
        key,
        ciphertext,
      );
      options.signal?.throwIfAborted();
      return new Uint8Array(plaintext);
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new Error("session vault entry authentication failed", { cause: error });
    }
  }
}

function serializeMasterKey(raw: Uint8Array): string {
  const stored: StoredMasterKey = {
    schemaVersion: 1,
    algorithm: "AES-256-GCM",
    key: bytesToBase64(raw),
  };
  return JSON.stringify(stored);
}

async function importMasterKey(serialized: string): Promise<CryptoKey> {
  if (new TextEncoder().encode(serialized).byteLength > MAX_MASTER_KEY_SECRET_BYTES) {
    throw new Error("session encryption key is malformed");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error("session encryption key is malformed", { cause: error });
  }
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !("schemaVersion" in value) || value.schemaVersion !== 1 ||
    !("algorithm" in value) || value.algorithm !== "AES-256-GCM" ||
    !("key" in value) || typeof value.key !== "string"
  ) {
    throw new Error("session encryption key is malformed");
  }
  const raw = base64ToBytes(value.key);
  if (raw.byteLength !== MASTER_KEY_BYTES) {
    throw new Error("session encryption key is malformed");
  }
  return await crypto.subtle.importKey("raw", ownedBytes(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function bytesToBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

function base64ToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error("session encryption key is malformed");
  }
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch (error) {
    throw new Error("session encryption key is malformed", { cause: error });
  }
}

function startsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  if (value.byteLength < prefix.byteLength) return false;
  return prefix.every((byte, index) => value[index] === byte);
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

async function acquireExclusiveLock(file: Deno.FsFile, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const abort = () => {
    try {
      file.close();
    } catch {
      // close済みなら何もしない。
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await file.lock(true);
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
