import { assertEquals, assertThrows } from "@std/assert/";
import { AmazonAuthentication } from "./authentication.ts";
import { createAmazonContext } from "./context.ts";

Deno.test("AmazonAuthentication snapshot round-trips cookies and requires validation", async () => {
  const baseURL = "https://www.amazon.co.jp";
  const context = createAmazonContext({
    fetch: () =>
      Promise.resolve(responseAt(
        `${baseURL}/your-orders/orders?orderFilter=all`,
        '<main id="ordersContainer"><h1>注文履歴</h1></main>',
      )),
  });
  context.session.cookies.set(
    "session-id=secret-cookie; Domain=amazon.co.jp; Path=/; Secure; HttpOnly",
    new URL(baseURL),
    true,
  );
  context.authenticationState = "valid";
  const auth = new AmazonAuthentication(context);
  const snapshot = auth.captureSession();

  auth.clearSession();
  assertEquals(context.session.cookies.header(new URL(baseURL)), "");
  assertEquals(auth.restoreSession(snapshot), { status: "restored" });
  assertEquals((await auth.validateSession()).status, "valid");
  assertEquals(
    context.session.cookies.header(new URL(baseURL)),
    "session-id=secret-cookie",
  );
});

Deno.test("AmazonAuthentication returns typed rejection for foreign or unsupported snapshots", () => {
  const auth = new AmazonAuthentication(createAmazonContext());
  assertEquals(
    auth.restoreSession({
      schemaVersion: 1,
      provider: "jcb",
      capturedAt: new Date().toISOString(),
      payload: { cookies: [] },
    }),
    { status: "rejected", reason: "provider-mismatch" },
  );
  assertEquals(
    auth.restoreSession({
      schemaVersion: 99,
      provider: "amazon",
      capturedAt: new Date().toISOString(),
      payload: { cookies: [] },
    }),
    { status: "rejected", reason: "unsupported-schema" },
  );
  assertThrows(() => auth.captureSession(), TypeError);
});

function responseAt(url: string, body: string): Response {
  const response = new Response(body, { status: 200 });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
