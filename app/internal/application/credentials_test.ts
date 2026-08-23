import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert/";
import { createProviderConnection } from "../model/connection.ts";
import type { CredentialInput } from "./credentials.ts";
import { FakeCredentialVault } from "../testing/authentication.ts";
import { CredentialCoordinator, storedPasswordCredential } from "./credentials.ts";

interface TestCredentials {
  readonly identifier: string;
  readonly password: string;
}

const key = createProviderConnection("amazon", "personal");

Deno.test("CredentialCoordinator resolves environment before keyring and prompt", async () => {
  const vault = new FakeCredentialVault();
  vault.loaded = storedPasswordCredential(key, "saved@example.test", "saved-password");
  let prompted = false;
  const coordinator = new CredentialCoordinator(
    vault,
    input({
      identifier: "env@example.test",
      password: "env-password",
    }, () => {
      prompted = true;
      return Promise.resolve({ identifier: "prompt@example.test", password: "prompt-password" });
    }),
  );

  const acquired = await coordinator.acquire(key);

  assertEquals(acquired.source, "environment");
  assertEquals(acquired.value.identifier, "env@example.test");
  assertEquals(vault.loadCount, 0);
  assertEquals(prompted, false);
});

Deno.test("CredentialCoordinator uses a valid saved credential before prompting", async () => {
  const vault = new FakeCredentialVault();
  vault.loaded = storedPasswordCredential(key, "saved@example.test", "saved-password");
  let prompted = false;
  const coordinator = new CredentialCoordinator(
    vault,
    input(undefined, () => {
      prompted = true;
      return Promise.resolve({ identifier: "prompt@example.test", password: "prompt-password" });
    }),
  );

  const acquired = await coordinator.acquire(key);

  assertEquals(acquired.source, "keyring");
  assertEquals(acquired.value, {
    identifier: "saved@example.test",
    password: "saved-password",
  });
  assertEquals(vault.loadCount, 1);
  assertEquals(prompted, false);
});

Deno.test("CredentialCoordinator prompts when environment and keyring are empty", async () => {
  const vault = new FakeCredentialVault();
  const coordinator = new CredentialCoordinator(
    vault,
    input(
      undefined,
      () => Promise.resolve({ identifier: "prompt@example.test", password: "prompt-password" }),
    ),
  );

  const acquired = await coordinator.acquire(key);

  assertEquals(acquired.source, "interactive");
  assertEquals(acquired.value.identifier, "prompt@example.test");
  assertEquals(vault.loadCount, 1);
});

Deno.test("CredentialCoordinator rejects a saved credential for another connection", async () => {
  const vault = new FakeCredentialVault();
  vault.loaded = storedPasswordCredential(
    createProviderConnection("amazon", "business"),
    "saved@example.test",
    "saved-password",
  );
  const coordinator = new CredentialCoordinator(
    vault,
    input(
      undefined,
      () => Promise.resolve({ identifier: "prompt@example.test", password: "prompt-password" }),
    ),
  );

  await assertRejects(() => coordinator.acquire(key), TypeError, "another connection");
  assertEquals(vault.removeCount, 0);
});

Deno.test("CredentialCoordinator rejects unsupported saved fields including OTP", async () => {
  const vault = new FakeCredentialVault();
  vault.loaded = {
    ...storedPasswordCredential(key, "saved@example.test", "saved-password"),
    otp: "123456",
  };
  const coordinator = new CredentialCoordinator(
    vault,
    input(
      undefined,
      () => Promise.resolve({ identifier: "prompt@example.test", password: "prompt-password" }),
    ),
  );

  await assertRejects(() => coordinator.acquire(key), TypeError, "unsupported fields");
  assertEquals(vault.removeCount, 0);
});

Deno.test("CredentialCoordinator reports non-abort keyring write failures", async () => {
  const vault = new FakeCredentialVault();
  const writeError = new Error("store unavailable");
  vault.saveError = writeError;
  const coordinator = new CredentialCoordinator(
    vault,
    input(
      undefined,
      () => Promise.resolve({ identifier: "prompt@example.test", password: "prompt-password" }),
    ),
  );
  const acquired = await coordinator.acquire(key);

  const result = await coordinator.save(key, acquired);

  assertEquals(result.status, "failed");
  if (result.status === "failed") assertStrictEquals(result.error, writeError);
});

Deno.test("CredentialCoordinator preserves AbortError from keyring writes", async () => {
  const vault = new FakeCredentialVault();
  vault.saveError = new DOMException("cancelled", "AbortError");
  const coordinator = new CredentialCoordinator(
    vault,
    input(
      undefined,
      () => Promise.resolve({ identifier: "prompt@example.test", password: "prompt-password" }),
    ),
  );
  const acquired = await coordinator.acquire(key);

  await assertRejects(
    () => coordinator.save(key, acquired),
    DOMException,
    "cancelled",
  );
});

function input(
  environment: TestCredentials | undefined,
  prompt: () => Promise<TestCredentials>,
): CredentialInput<"amazon", TestCredentials> {
  return {
    readEnvironment: () => Promise.resolve(environment),
    prompt,
    fromStored: (stored) => ({
      identifier: stored.identifier,
      password: stored.password,
    }),
    toStored: (connection, credentials) =>
      storedPasswordCredential(connection, credentials.identifier, credentials.password),
  };
}
