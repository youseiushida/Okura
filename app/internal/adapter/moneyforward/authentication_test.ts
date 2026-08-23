import { assertEquals, assertRejects, assertThrows } from "@std/assert/";
import { createProviderConnection } from "../../model/connection.ts";
import { MoneyForwardAuthentication } from "./authentication.ts";
import { createMoneyForwardContext } from "./context.ts";

Deno.test("MoneyForwardAuthentication round-trips only allowed session cookies", async () => {
  const context = createMoneyForwardContext({
    fetch: (input) =>
      Promise.resolve(responseAt(
        new URL(input instanceof Request ? input.url : input).href,
        `
      <meta name="csrf-token" content="csrf">
      <body class="cf_controller index_action"><form action="/cf/create"></form></body>`,
      )),
  });
  context.session.cookies.set(
    "session=secret; Domain=moneyforward.com; Path=/; Secure; HttpOnly",
    context.baseURL,
    true,
  );
  context.authenticationState = "valid";
  const auth = new MoneyForwardAuthentication(context);
  const snapshot = auth.captureSession();

  auth.clearSession();
  assertEquals(auth.restoreSession(snapshot), { status: "restored" });
  assertEquals((await auth.validateSession()).status, "valid");
  assertEquals(context.session.cookies.header(context.baseURL), "session=secret");
});

Deno.test("MoneyForwardAuthentication does not classify an ambiguous 403 as expired", async () => {
  const context = createMoneyForwardContext({
    fetch: () => Promise.resolve(responseAt("https://moneyforward.com/cf", "forbidden", 403)),
  });
  context.authenticationState = "restored";
  await assertRejects(() => new MoneyForwardAuthentication(context).validateSession());
  assertEquals(context.authenticationState, "restored");
});

Deno.test("MoneyForwardAuthentication rejects a session from another connection", () => {
  const personalContext = createMoneyForwardContext({
    connection: createProviderConnection("moneyforward", "personal"),
  });
  personalContext.authenticationState = "valid";
  const snapshot = new MoneyForwardAuthentication(personalContext).captureSession();
  const businessAuth = new MoneyForwardAuthentication(createMoneyForwardContext({
    connection: createProviderConnection("moneyforward", "business"),
  }));

  assertEquals(businessAuth.restoreSession(snapshot), {
    status: "rejected",
    reason: "connection-mismatch",
  });
});

Deno.test("MoneyForwardAuthentication rejects foreign cookies and unsupported snapshots", () => {
  const auth = new MoneyForwardAuthentication(createMoneyForwardContext());
  assertEquals(
    auth.restoreSession({
      schemaVersion: 1,
      provider: "moneyforward",
      connectionID: auth.connection.id,
      capturedAt: new Date().toISOString(),
      payload: {
        cookies: [{
          name: "session",
          value: "secret",
          domain: "attacker.example",
          path: "/",
          hostOnly: true,
          secure: true,
          httpOnly: true,
        }],
      },
    }),
    { status: "rejected", reason: "malformed" },
  );
  assertEquals(
    auth.restoreSession({
      schemaVersion: 99,
      provider: "moneyforward",
      capturedAt: new Date().toISOString(),
      payload: { cookies: [] },
    }),
    { status: "rejected", reason: "unsupported-schema" },
  );
  assertThrows(() => auth.captureSession(), TypeError);
});

function responseAt(url: string, body: string, status = 200): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
