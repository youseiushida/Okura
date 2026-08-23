import { assertEquals, assertThrows } from "@std/assert/";
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

Deno.test("JCBAuthentication rejects malformed user-agent state", () => {
  const auth = new JCBAuthentication(createJCBContext());
  assertEquals(
    auth.restoreSession({
      schemaVersion: 1,
      provider: "jcb",
      capturedAt: new Date().toISOString(),
      payload: { cookies: [], userAgent: "bad\nagent" },
    }),
    { status: "rejected", reason: "malformed" },
  );
  assertThrows(() => auth.captureSession(), TypeError);
});

function responseAt(url: string, body: string): Response {
  const response = new Response(body, { status: 200 });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
