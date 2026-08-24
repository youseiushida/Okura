import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert/";
import { FakeSecretStore } from "../../testing/secret_store.ts";
import { TwoCaptchaApiKey, TwoCaptchaApiKeyUnavailableError } from "./two_captcha_api_key.ts";
import { TwoCaptchaError, TwoCaptchaTurnstileSolver } from "./two_captcha.ts";

const SERVICE = "Okura 2Captcha API key v1";
const ACCOUNT = "default";
const SLOT = `${SERVICE}\u0000${ACCOUNT}`;
const ENVIRONMENT_KEY = "a".repeat(32);
const STORED_KEY = "b".repeat(32);

Deno.test("TwoCaptchaApiKey resolves the environment without touching the keyring", async () => {
  const store = new FakeSecretStore();
  store.values.set(SLOT, STORED_KEY);
  const apiKey = new TwoCaptchaApiKey(
    store,
    (name) => name === "TWOCAPTCHA_API_KEY" ? ENVIRONMENT_KEY : undefined,
  );

  assertEquals(await apiKey.resolve(), ENVIRONMENT_KEY);
  assertEquals(store.calls, []);
});

Deno.test("TwoCaptchaApiKey resolves the shared keyring entry when the environment is absent", async () => {
  const store = new FakeSecretStore();
  store.values.set(SLOT, STORED_KEY);
  const apiKey = new TwoCaptchaApiKey(store, () => undefined);

  assertEquals(await apiKey.resolve(), STORED_KEY);
  assertEquals(store.calls, [{ operation: "get", service: SERVICE, account: ACCOUNT }]);
});

Deno.test("TwoCaptchaApiKey does not fall back from an invalid environment value", async () => {
  const store = new FakeSecretStore();
  store.values.set(SLOT, STORED_KEY);
  const apiKey = new TwoCaptchaApiKey(store, () => "invalid");

  await assertRejects(() => apiKey.resolve(), TypeError, "32-character hexadecimal");
  assertEquals(store.calls, []);
});

Deno.test("TwoCaptchaApiKey reports a missing key without writing or removing", async () => {
  const store = new FakeSecretStore();
  const apiKey = new TwoCaptchaApiKey(store, () => undefined);

  await assertRejects(
    () => apiKey.resolve(),
    TwoCaptchaApiKeyUnavailableError,
    "solver 2captcha configure",
  );
  assertEquals(store.calls, [{ operation: "get", service: SERVICE, account: ACCOUNT }]);
});

Deno.test("TwoCaptchaApiKey explicitly configures and removes one global keyring entry", async () => {
  const store = new FakeSecretStore();
  const apiKey = new TwoCaptchaApiKey(store, () => undefined);

  await apiKey.configure(ENVIRONMENT_KEY);
  assertEquals(store.values.get(SLOT), ENVIRONMENT_KEY);
  await apiKey.remove();

  assertEquals(store.values.has(SLOT), false);
  assertEquals(store.calls, [
    { operation: "set", service: SERVICE, account: ACCOUNT },
    { operation: "remove", service: SERVICE, account: ACCOUNT },
  ]);
});

Deno.test("TwoCaptchaApiKey rejects invalid input before changing a saved key", async () => {
  const store = new FakeSecretStore();
  store.values.set(SLOT, STORED_KEY);
  const apiKey = new TwoCaptchaApiKey(store, () => undefined);

  await assertRejects(() => apiKey.configure("invalid"), TypeError);

  assertEquals(store.values.get(SLOT), STORED_KEY);
  assertEquals(store.calls, []);
});

Deno.test("TwoCaptchaApiKey preserves abort reasons from keyring access", async () => {
  const reason = new DOMException("cancelled", "AbortError");
  const store = new FakeSecretStore();
  store.getError = reason;
  const apiKey = new TwoCaptchaApiKey(store, () => undefined);

  const error = await assertRejects(() => apiKey.resolve());

  assertStrictEquals(error, reason);
  assertEquals(store.calls, [{ operation: "get", service: SERVICE, account: ACCOUNT }]);
});

Deno.test("2Captcha service failures retain the stored API key", async () => {
  const store = new FakeSecretStore();
  store.values.set(SLOT, STORED_KEY);
  const apiKey = new TwoCaptchaApiKey(store, () => undefined);
  const solver = new TwoCaptchaTurnstileSolver({
    apiKey: (options) => apiKey.resolve(options),
    fetch: () => Promise.resolve(json({ errorId: 10, errorCode: "ERROR_ZERO_BALANCE" })),
  });

  await assertRejects(
    () => solver.solve({ pageURL: "https://example.com/", siteKey: "site-key" }),
    TwoCaptchaError,
    "ERROR_ZERO_BALANCE",
  );

  assertEquals(store.values.get(SLOT), STORED_KEY);
  assertEquals(store.calls, [{ operation: "get", service: SERVICE, account: ACCOUNT }]);
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
