import { assertEquals, assertRejects } from "@std/assert/";
import { createProviderConnection } from "../../model/connection.ts";
import type { StoredPasswordCredential } from "../../port/credential_vault.ts";
import { FakeSecretStore } from "../../testing/secret_store.ts";
import { KeyringCredentialVault } from "./keyring_vault.ts";

Deno.test("KeyringCredentialVault stores opaque JSON under the connection account", async () => {
  const store = new FakeSecretStore();
  const service = "Okura credential test";
  const vault = new KeyringCredentialVault(store, service);
  const key = createProviderConnection("amazon", "personal");
  const credential = testCredential(key.id);

  await vault.save(key, credential);

  assertEquals(store.calls, [{ operation: "set", service, account: key.id }]);
  assertEquals(await vault.load(key), credential);
  await vault.remove(key);
  assertEquals(await vault.load(key), undefined);
});

Deno.test("KeyringCredentialVault rejects a connection mismatch before writing", async () => {
  const store = new FakeSecretStore();
  const vault = new KeyringCredentialVault(store);
  const key = createProviderConnection("amazon", "personal");
  const foreign = testCredential(createProviderConnection("amazon", "business").id);

  await assertRejects(() => vault.save(key, foreign), TypeError, "connection do not match");
  assertEquals(store.calls, []);
});

Deno.test("KeyringCredentialVault distinguishes missing and malformed entries", async () => {
  const store = new FakeSecretStore();
  const service = "Okura malformed credential test";
  const vault = new KeyringCredentialVault(store, service);
  const key = createProviderConnection("amazon", "personal");

  assertEquals(await vault.load(key), undefined);
  store.values.set(`${service}\u0000${key.id}`, "not-json");
  await assertRejects(() => vault.load(key), Error, "not valid JSON");
});

function testCredential(connectionID: string): StoredPasswordCredential<"amazon"> {
  return {
    schemaVersion: 1,
    provider: "amazon",
    connectionID,
    identifier: "user@example.test",
    password: "test-password",
  };
}
