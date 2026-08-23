import { KeyringCredentialVault } from "../internal/adapter/credential/keyring_vault.ts";
import { createDefaultSecretStore } from "../internal/adapter/keyring/os_keyring.ts";
import {
  AesGcmDataProtector,
  KeyringMasterKeyProvider,
} from "../internal/adapter/session/encrypted_vault.ts";
import { FileSessionVault } from "../internal/adapter/session/file_vault.ts";
import { storedPasswordCredential } from "../internal/application/credentials.ts";
import { createProviderConnection } from "../internal/model/connection.ts";
import type { ProviderSessionSnapshot } from "../internal/port/authentication.ts";

const identifier = crypto.randomUUID();
const profile = `native-smoke-${identifier}`;
const connection = createProviderConnection("amazon", profile);
const credentialService = `Okura credential native smoke ${identifier}`;
const sessionKeyService = `Okura session native smoke ${identifier}`;
const sessionKeyAccount = "default";
const password = `test-${crypto.randomUUID()}`;
const store = createDefaultSecretStore();
const credentialVault = new KeyringCredentialVault(store, credentialService);
const sessionRoot = await Deno.makeTempDir({ prefix: "okura-native-session-smoke-" });
const sessionVault = new FileSessionVault(
  sessionRoot,
  new AesGcmDataProtector(
    new KeyringMasterKeyProvider(store, sessionRoot, sessionKeyService, sessionKeyAccount),
  ),
);

let smokeFailure: unknown;
try {
  const credential = storedPasswordCredential(connection, `smoke-${identifier}`, password);
  assertEqual(await credentialVault.load(connection), undefined, "missing credential lookup");
  await credentialVault.save(connection, credential);
  assertEqual(await credentialVault.load(connection), credential, "credential keyring round trip");
  await credentialVault.remove(connection);
  assertEqual(await credentialVault.load(connection), undefined, "credential keyring removal");
  await credentialVault.save(connection, credential);

  const aborted = new AbortController();
  aborted.abort(new DOMException("native smoke abort", "AbortError"));
  await assertAbort(() => credentialVault.load(connection, { signal: aborted.signal }));

  const session = snapshot(connection.id, `test-cookie-${crypto.randomUUID()}`);
  await sessionVault.save(connection, session);
  assertEqual(await sessionVault.load(connection), session, "AES-GCM session round trip");
} catch (error) {
  smokeFailure = error;
}

const cleanup = await Promise.allSettled([
  credentialVault.remove(connection),
  store.remove(sessionKeyService, sessionKeyAccount),
  Deno.remove(sessionRoot, { recursive: true }),
]);
const cleanupFailures = cleanup.flatMap((result) =>
  result.status === "rejected" ? [result.reason] : []
);
if (cleanupFailures.length > 0) {
  throw new AggregateError(
    smokeFailure === undefined ? cleanupFailures : [smokeFailure, ...cleanupFailures],
    "native storage smoke cleanup failed",
  );
}
if (smokeFailure !== undefined) throw smokeFailure;
console.log(`Native storage smoke passed on ${Deno.build.os}.`);

function snapshot(
  connectionID: string,
  cookie: string,
): ProviderSessionSnapshot<"amazon"> {
  return {
    schemaVersion: 1,
    provider: "amazon",
    connectionID,
    capturedAt: "2026-08-23T00:00:00.000Z",
    payload: { cookie },
  };
}

function assertEqual(actual: unknown, expected: unknown, operation: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${operation} failed`);
  }
}

async function assertAbort(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return;
    throw error;
  }
  throw new Error("native storage operation ignored AbortSignal");
}
