import { assertRejects, assertThrows } from "@std/assert/";
import { assertSafeNapiEnvironment, NapiKeyringSecretStore } from "./os_keyring.ts";

Deno.test("assertSafeNapiEnvironment accepts an absent or empty native library override", () => {
  assertSafeNapiEnvironment(() => undefined);
  assertSafeNapiEnvironment(() => "  ");
});

Deno.test("assertSafeNapiEnvironment rejects an inherited native library override", () => {
  assertThrows(
    () => assertSafeNapiEnvironment(() => "untrusted.node"),
    Error,
    "NAPI_RS_NATIVE_LIBRARY_PATH overrides are not supported",
  );
});

Deno.test("NapiKeyringSecretStore rejects the override before importing native code", async () => {
  const store = new NapiKeyringSecretStore(() => "untrusted.node");
  await assertRejects(
    () => store.get("test-service", "test-account"),
    Error,
    "NAPI_RS_NATIVE_LIBRARY_PATH overrides are not supported",
  );
});
