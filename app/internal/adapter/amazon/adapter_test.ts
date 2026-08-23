import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert/";
import { createWallet } from "../../model/account.ts";
import { AuthenticationRequiredError } from "../../port/source.ts";
import { AmazonAdapter } from "./adapter.ts";
import { AmazonAuthentication } from "./authentication.ts";
import { createAmazonContext } from "./context.ts";

const period = {
  from: new Date("2026-07-31T15:00:00.000Z"),
  to: new Date("2026-08-01T15:00:00.000Z"),
};

Deno.test("AmazonAdapter expires a confirmed logged-out session", async () => {
  const context = createAmazonContext({
    fetch: () => Promise.resolve(responseAt("https://www.amazon.co.jp/ap/signin", "sign in")),
  });
  context.authenticationState = "valid";
  const adapter = adapterFor(context);
  const error = await assertRejects(() => adapter.fetchCashOuts(period));

  assertEquals(error instanceof AuthenticationRequiredError, true);
  assertEquals(context.authenticationState, "expired");
  assertThrows(() => new AmazonAuthentication(context).captureSession(), TypeError);
});

Deno.test("AmazonAdapter does not expire a session on an ambiguous 403", async () => {
  const context = createAmazonContext({
    fetch: () =>
      Promise.resolve(responseAt("https://www.amazon.co.jp/your-orders/orders", "waf", 403)),
  });
  context.authenticationState = "valid";

  await assertRejects(() => adapterFor(context).fetchCashOuts(period));
  assertEquals(context.authenticationState, "valid");
});

Deno.test("AmazonAdapter preserves AbortSignal reason", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled", "AbortError");
  controller.abort(reason);
  const context = createAmazonContext({
    fetch: (_input, init) => {
      init?.signal?.throwIfAborted();
      return Promise.reject(new Error("request should have been aborted"));
    },
  });
  context.authenticationState = "valid";
  const error = await assertRejects(() =>
    adapterFor(context).fetchCashOuts(period, { signal: controller.signal })
  );
  assertStrictEquals(error, reason);
});

function adapterFor(context: ReturnType<typeof createAmazonContext>): AmazonAdapter {
  return new AmazonAdapter(context, {
    wallet: createWallet(context.connection, "amazon", "Amazon"),
    pageDelayMs: 0,
  });
}

function responseAt(url: string, body: string, status = 200): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
