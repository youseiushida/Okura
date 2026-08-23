import { assertEquals, assertRejects, assertThrows } from "@std/assert/";
import { JCBAuthentication } from "./authentication.ts";
import { createJCBContext } from "./context.ts";
import { MYPAGE_PATH } from "./login.ts";

Deno.test("JCBAuthentication snapshot round-trips cookies and user agent", async () => {
  const baseURL = "https://my.jcb.co.jp";
  const context = createJCBContext({
    fetch: () => Promise.resolve(responseAt(`${baseURL}${MYPAGE_PATH}`, "mypage")),
  });
  context.session.cookies.set(
    "MYJCB_SESSION=secret-cookie; Domain=my.jcb.co.jp; Path=/; Secure; HttpOnly",
    new URL(baseURL),
    true,
  );
  context.userAgent = "snapshot-agent";
  context.authenticationState = "valid";
  const auth = new JCBAuthentication(context);
  const snapshot = auth.captureSession();

  auth.clearSession();
  assertEquals(auth.restoreSession(snapshot), { status: "restored" });
  assertEquals((await auth.validateSession()).status, "valid");
  assertEquals(context.userAgent, "snapshot-agent");
  assertEquals(
    context.session.cookies.header(new URL(baseURL)),
    "MYJCB_SESSION=secret-cookie",
  );
});

Deno.test("JCBAuthentication does not classify an ambiguous 403 as expired", async () => {
  const context = createJCBContext({
    fetch: () =>
      Promise.resolve(responseAt(`https://my.jcb.co.jp${MYPAGE_PATH}`, "forbidden", 403)),
  });
  context.authenticationState = "restored";
  context.userAgent = "test-agent";
  await assertRejects(() => new JCBAuthentication(context).validateSession());
  assertEquals(context.authenticationState, "restored");
});

Deno.test("JCBAuthentication rejects malformed user-agent state", () => {
  const auth = new JCBAuthentication(createJCBContext());
  assertEquals(
    auth.restoreSession({
      schemaVersion: 1,
      provider: "jcb",
      connectionID: auth.connection.id,
      capturedAt: new Date().toISOString(),
      payload: { cookies: [], userAgent: "bad\nagent" },
    }),
    { status: "rejected", reason: "malformed" },
  );
  assertThrows(() => auth.captureSession(), TypeError);
});

function responseAt(url: string, body: string, status = 200): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
