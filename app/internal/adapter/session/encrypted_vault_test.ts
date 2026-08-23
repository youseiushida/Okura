import { assertEquals, assertRejects } from "@std/assert/";
import { join } from "node:path";
import { createProviderConnection } from "../../model/connection.ts";
import type { ProviderSessionSnapshot } from "../../port/authentication.ts";
import { FakeSecretStore } from "../../testing/secret_store.ts";
import { AesGcmDataProtector, KeyringMasterKeyProvider } from "./encrypted_vault.ts";
import { FileSessionVault } from "./file_vault.ts";

Deno.test("AES-GCM session vault keeps snapshot data out of the file and keyring", async () => {
  const root = await Deno.makeTempDir({ prefix: "okura-aes-session-test-" });
  const store = new FakeSecretStore();
  const vault = aesVault(root, store, "Okura session test");
  const key = createProviderConnection("amazon", "personal");
  const value = snapshot(key.id, "test-cookie-value");
  try {
    await vault.save(key, value);

    assertEquals(await vault.load(key), value);
    const entries = [...Deno.readDirSync(root)].filter((entry) =>
      entry.isFile && entry.name.endsWith(".session")
    );
    assertEquals(entries.length, 1);
    const encrypted = await Deno.readFile(join(root, entries[0]?.name ?? ""));
    assertEquals(new TextDecoder().decode(encrypted).includes("test-cookie-value"), false);
    assertEquals(
      [...store.values.values()].some((secret) => secret.includes("test-cookie-value")),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("AES-GCM session vault rejects a modified ciphertext", async () => {
  const root = await Deno.makeTempDir({ prefix: "okura-aes-tamper-test-" });
  const store = new FakeSecretStore();
  const vault = aesVault(root, store, "Okura tamper test");
  const key = createProviderConnection("amazon", "personal");
  try {
    await vault.save(key, snapshot(key.id, "test-cookie-value"));
    const entry = [...Deno.readDirSync(root)].find((candidate) =>
      candidate.name.endsWith(".session")
    );
    const path = join(root, entry?.name ?? "");
    const encrypted = await Deno.readFile(path);
    const lastIndex = encrypted.byteLength - 1;
    encrypted[lastIndex] = (encrypted[lastIndex] ?? 0) ^ 1;
    await Deno.writeFile(path, encrypted);

    await assertRejects(() => vault.load(key), Error, "authentication failed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("concurrent master key initialization persists a single shared key", async () => {
  const root = await Deno.makeTempDir({ prefix: "okura-key-init-test-" });
  const store = new FakeSecretStore();
  const service = "Okura concurrent key test";
  try {
    const first = new KeyringMasterKeyProvider(store, root, service);
    const second = new KeyringMasterKeyProvider(store, root, service);
    const [firstKey, secondKey] = await Promise.all([first.get(), second.get()]);
    const sample = new Uint8Array([1, 2, 3]);
    const iv = new Uint8Array(12);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, firstKey, sample);
    assertEquals(
      new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, secondKey, encrypted)),
      sample,
    );
    assertEquals(store.calls.filter((call) => call.operation === "set").length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("master key provider rejects malformed keyring data", async () => {
  const root = await Deno.makeTempDir({ prefix: "okura-bad-key-test-" });
  const store = new FakeSecretStore();
  const service = "Okura malformed key test";
  store.values.set(`${service}\u0000default`, "not-a-master-key");
  try {
    const provider = new KeyringMasterKeyProvider(store, root, service);
    await assertRejects(() => provider.get(), Error, "malformed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

function aesVault(root: string, store: FakeSecretStore, service: string): FileSessionVault {
  return new FileSessionVault(
    root,
    new AesGcmDataProtector(new KeyringMasterKeyProvider(store, root, service)),
  );
}

function snapshot(connectionID: string, cookie: string): ProviderSessionSnapshot<"amazon"> {
  return {
    schemaVersion: 1,
    provider: "amazon",
    connectionID,
    capturedAt: "2026-08-23T00:00:00.000Z",
    payload: { cookie },
  };
}
