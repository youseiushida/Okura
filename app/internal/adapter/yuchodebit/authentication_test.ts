import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert/";
import type { AuthInteraction } from "../../port/auth_interaction.ts";
import type { TurnstileChallenge } from "../../port/turnstile_solver.ts";
import { YuchoDebitAuthentication } from "./authentication.ts";
import { createYuchoDebitContext } from "./context.ts";
import { UnexpectedPageError, YuchoDebitError } from "./errors.ts";
import { HOME_PATH, LOGIN_PATH, LOGIN_SUBMIT_PATH } from "./routes.ts";
import { authenticatedHomeHTML, loginHTML, startTestServer } from "./test_util.ts";

const interaction: AuthInteraction = {
  otp: { request: () => Promise.reject(new Error("OTP was not expected")) },
  progress: { publish: () => Promise.resolve() },
};

Deno.test("YuchoDebitAuthentication uses the solver agent for a fresh login session", async () => {
  const challenges: TurnstileChallenge[] = [];
  let loginGets = 0;
  let homeGets = 0;
  const server = startTestServer(async (request) => {
    const url = new URL(request.url);
    const path = stripParameters(url.pathname);
    if (path === LOGIN_PATH && request.method === "GET") {
      loginGets += 1;
      assertEquals(url.searchParams.get("cc"), "01010");
      if (loginGets === 1) {
        assertEquals(request.headers.get("Cookie"), null);
        return html(loginHTML(), { "Set-Cookie": "JSESSIONID=discovery; Path=/; HttpOnly" });
      }
      assertEquals(request.headers.get("Cookie"), null);
      assertEquals(request.headers.get("User-Agent"), "solver-agent");
      return html(loginHTML(), { "Set-Cookie": "JSESSIONID=login-seed; Path=/; HttpOnly" });
    }
    if (path === LOGIN_SUBMIT_PATH && request.method === "POST") {
      assertEquals(request.headers.get("User-Agent"), "solver-agent");
      assert(request.headers.get("Cookie")?.includes("JSESSIONID=login-seed"));
      const body = new URLSearchParams(await request.text());
      assertEquals(body.get("usrId"), "test-user");
      assertEquals(body.get("password"), "test-password");
      assertEquals(body.get("cf-turnstile-response"), "single-use-token");
      assertEquals(body.get("nablarch_submit"), "nablarch_form1_1");
      return html(authenticatedHomeHTML(), {
        "Set-Cookie": "AUTH=authenticated; Path=/; HttpOnly",
      });
    }
    if (path === HOME_PATH && request.method === "GET") {
      homeGets += 1;
      assert(request.headers.get("Cookie")?.includes("AUTH=authenticated"));
      assertEquals(request.headers.get("User-Agent"), "solver-agent");
      return html(authenticatedHomeHTML());
    }
    return new Response("not found", { status: 404 });
  });
  try {
    const context = createYuchoDebitContext({ baseURL: server.url });
    const auth = new YuchoDebitAuthentication(context, {
      solver: {
        solve(challenge) {
          challenges.push(challenge);
          return Promise.resolve({ token: "single-use-token", userAgent: "solver-agent" });
        },
      },
    });

    await auth.login(
      { userID: "test-user", password: "test-password" },
      { interaction },
    );
    assertEquals(loginGets, 2);
    assertEquals(challenges.length, 1);
    assertEquals(challenges[0]?.siteKey, "test-site-key");
    assertEquals(context.authenticationState, "valid");

    const snapshot = auth.captureSession();
    const serialized = JSON.stringify(snapshot);
    assertEquals(serialized.includes("test-user"), false);
    assertEquals(serialized.includes("test-password"), false);
    assertEquals(serialized.includes("single-use-token"), false);
    assertEquals(serialized.includes("discovery"), false);
    assertEquals(serialized.includes("solver-agent"), true);

    auth.clearSession();
    assertEquals(auth.restoreSession(snapshot), { status: "restored" });
    assertEquals(await auth.validateSession(), { status: "valid" });
    assertEquals(homeGets, 1);
  } finally {
    await server.close();
  }
});

Deno.test("YuchoDebitAuthentication rejects foreign and malformed snapshots atomically", () => {
  const context = createYuchoDebitContext();
  const auth = new YuchoDebitAuthentication(context, {
    solver: { solve: () => Promise.reject(new Error("not expected")) },
  });
  const valid = {
    schemaVersion: 1,
    provider: "yucho-debit",
    connectionID: context.connection.id,
    capturedAt: new Date().toISOString(),
    payload: { cookies: [], userAgent: "test-agent" },
  };

  assertEquals(auth.restoreSession({ ...valid, provider: "jcb" }), {
    status: "rejected",
    reason: "provider-mismatch",
  });
  assertEquals(auth.restoreSession({ ...valid, connectionID: "yucho-debit/foreign" }), {
    status: "rejected",
    reason: "connection-mismatch",
  });
  assertEquals(auth.restoreSession({ ...valid, schemaVersion: 2 }), {
    status: "rejected",
    reason: "unsupported-schema",
  });
  assertEquals(
    auth.restoreSession({
      ...valid,
      payload: { ...valid.payload, password: "must-not-be-accepted" },
    }),
    { status: "rejected", reason: "malformed" },
  );
  assertEquals(auth.restoreSession({ ...valid, capturedAt: "2026-08-24" }), {
    status: "rejected",
    reason: "malformed",
  });
  assertEquals(
    auth.restoreSession({
      ...valid,
      payload: {
        cookies: [{
          name: "SESSION",
          value: "secret",
          domain: "example.com",
          path: "/",
          hostOnly: true,
          secure: true,
          httpOnly: true,
        }],
        userAgent: "test-agent",
      },
    }),
    { status: "rejected", reason: "malformed" },
  );
  assertEquals(
    auth.restoreSession({
      ...valid,
      payload: {
        cookies: [{
          name: "SESSION",
          value: "secret",
          domain: context.baseURL.hostname,
          path: "/",
          hostOnly: true,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        }],
        userAgent: "test-agent",
      },
    }),
    { status: "rejected", reason: "malformed" },
  );
  assertEquals(
    auth.restoreSession({
      ...valid,
      payload: {
        cookies: [{
          name: "SESSION",
          value: "secret",
          domain: "vpass.ne.jp",
          path: "/",
          hostOnly: false,
          secure: true,
          httpOnly: true,
        }],
        userAgent: "test-agent",
      },
    }),
    { status: "rejected", reason: "malformed" },
  );
  assertEquals(context.session.cookies.capture(), []);
  assertEquals(context.authenticationState, "empty");
  assertThrows(() => auth.captureSession(), TypeError);
});

Deno.test("YuchoDebitAuthentication clears partial session state when solving fails", async () => {
  const server = startTestServer(() =>
    html(loginHTML(), { "Set-Cookie": "JSESSIONID=partial; Path=/; HttpOnly" })
  );
  try {
    const context = createYuchoDebitContext({ baseURL: server.url });
    const auth = new YuchoDebitAuthentication(context, {
      solver: { solve: () => Promise.reject(new Error("solver failed")) },
    });

    await assertRejects(
      () => auth.login({ userID: "user", password: "password" }, { interaction }),
      Error,
      "solver failed",
    );
    assertEquals(context.session.cookies.capture(), []);
    assertEquals(context.authenticationState, "empty");
    assertEquals(context.userAgent, "");
  } finally {
    await server.close();
  }
});

Deno.test("YuchoDebitAuthentication does not classify an ambiguous 403 as expired", async () => {
  const context = createYuchoDebitContext({
    fetch: () => Promise.resolve(new Response("forbidden", { status: 403 })),
  });
  const auth = new YuchoDebitAuthentication(context, {
    solver: { solve: () => Promise.reject(new Error("not expected")) },
  });
  assertEquals(
    auth.restoreSession({
      schemaVersion: 1,
      provider: "yucho-debit",
      connectionID: context.connection.id,
      capturedAt: new Date().toISOString(),
      payload: { cookies: [], userAgent: "test-agent" },
    }),
    { status: "restored" },
  );

  await assertRejects(() => auth.validateSession(), YuchoDebitError, "unexpected HTTP 403");
  assertEquals(context.authenticationState, "restored");
});

Deno.test("YuchoDebitAuthentication rejects a cross-origin validation response", async () => {
  const context = createYuchoDebitContext({
    fetch: () => Promise.resolve(responseAt("https://example.com/", authenticatedHomeHTML())),
  });
  const auth = new YuchoDebitAuthentication(context, {
    solver: { solve: () => Promise.reject(new Error("not expected")) },
  });
  assertEquals(
    auth.restoreSession({
      schemaVersion: 1,
      provider: "yucho-debit",
      connectionID: context.connection.id,
      capturedAt: new Date().toISOString(),
      payload: { cookies: [], userAgent: "test-agent" },
    }),
    { status: "restored" },
  );

  await assertRejects(() => auth.validateSession(), UnexpectedPageError, "unexpected URL");
  assertEquals(context.authenticationState, "restored");
});

function stripParameters(path: string): string {
  return path.replace(/;[^/]*$/, "");
}

function html(body: string, headers: HeadersInit = {}): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=UTF-8", ...headers },
  });
}

function responseAt(url: string, body: string): Response {
  const response = html(body);
  Object.defineProperty(response, "url", { value: url });
  return response;
}
