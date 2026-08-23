import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert/";
import type { AuthInteraction } from "../../port/auth_interaction.ts";
import { JCBAuthentication } from "./authentication.ts";
import { createJCBContext } from "./context.ts";
import { AuthenticationFailedError } from "./errors.ts";
import {
  type Credentials,
  generateProtection,
  isMypageResponse,
  LOGIN_PATH,
  LOGIN_SUBMIT_PATH,
  MYPAGE_PATH,
  validateProtectedBody,
} from "./login.ts";
import { HttpSession } from "./session.ts";
import { startTestServer } from "./test_util.ts";

const interaction: AuthInteraction = {
  otp: { request: () => Promise.reject(new Error("OTP was not expected")) },
  progress: { publish: () => Promise.resolve() },
};

Deno.test("JCBAuthentication.login submits a protected form with its HTTP session", async () => {
  const userAgent = "test-js-runtime";
  let serverURL = "";
  const server = startTestServer(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === LOGIN_SUBMIT_PATH) {
      assertEquals(request.method, "POST");
      assertEquals(request.headers.get("User-Agent"), userAgent);
      assert(request.headers.get("Cookie")?.includes("PROTECTION_SESSION=seed"));
      const body = new URLSearchParams(await request.text());
      assertEquals(body.get("userId"), "my-id");
      assertEquals(body.get("password"), "my-password");
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${serverURL}${MYPAGE_PATH}`,
          "Set-Cookie": "MYJCB_SESSION=authenticated; Path=/",
        },
      });
    }
    if (path === MYPAGE_PATH) {
      assert(request.headers.get("Cookie")?.includes("MYJCB_SESSION=authenticated"));
      return new Response("mypage");
    }
    return new Response("not found", { status: 404 });
  });
  serverURL = server.url;
  try {
    const context = createJCBContext({ baseURL: server.url });
    const auth = new JCBAuthentication(context, {
      generateProtection: ({ session, loginURL, credentials }) => {
        session.cookies.set("PROTECTION_SESSION=seed; Path=/", loginURL, true);
        return Promise.resolve({
          action: `${server.url}${LOGIN_SUBMIT_PATH}`,
          body: protectedBody(credentials),
          userAgent,
        });
      },
    });
    await auth.login({ userID: "my-id", password: "my-password" }, { interaction });
    assertEquals(context.userAgent, userAgent);
    assertEquals(context.authenticationState, "valid");
  } finally {
    await server.close();
  }
});

Deno.test("JCBAuthentication.login validates credentials before protection generation", async () => {
  const context = createJCBContext();
  let called = false;
  const auth = new JCBAuthentication(context, {
    generateProtection: () => {
      called = true;
      return Promise.reject(new Error("must not run"));
    },
  });
  await assertRejects(() => auth.login({ userID: "", password: "" }, { interaction }), TypeError);
  assertEquals(called, false);
});

Deno.test("JCBAuthentication.login rejects a non-mypage response", async () => {
  const server = startTestServer(() => new Response("invalid credentials"));
  try {
    const context = createJCBContext({ baseURL: server.url });
    const credentials = { userID: "id", password: "password" };
    const auth = new JCBAuthentication(context, {
      generateProtection: () =>
        Promise.resolve({
          action: `${server.url}${LOGIN_SUBMIT_PATH}`,
          body: protectedBody(credentials),
          userAgent: "test-agent",
        }),
    });
    await assertRejects(() => auth.login(credentials, { interaction }), AuthenticationFailedError);
  } finally {
    await server.close();
  }
});

Deno.test("generateProtection executes dynamic code without granting host permissions", async () => {
  const server = startTestServer((request) => {
    const url = new URL(request.url);
    if (url.pathname === LOGIN_PATH) {
      return new Response(
        `<!doctype html><html><head>
<script src="/apl/login-prot.js?init"></script></head><body></body></html>`,
        {
          headers: {
            "Content-Type": "text/html; charset=UTF-8",
            "Set-Cookie": "PROBE=seed; Path=/",
          },
        },
      );
    }
    if (url.pathname === "/apl/login-prot.js" && url.searchParams.has("init")) {
      return new Response(
        `const script = document.createElement("script");
script.src = "/apl/login-prot.js?async&seed=test";
document.head.appendChild(script);`,
        { headers: { "Content-Type": "application/javascript" } },
      );
    }
    if (url.pathname === "/apl/login-prot.js" && url.searchParams.has("async")) {
      return new Response(
        `const escapedDeno = this.constructor.constructor("return Deno")();
let deniedPermissions = 0;
try { escapedDeno.env.get("PATH"); } catch { deniedPermissions += 1; }
try { escapedDeno.readTextFileSync("deno.json"); } catch { deniedPermissions += 1; }
if (deniedPermissions !== 2) throw new Error("protection code escaped its permissions");
const originalSubmit = HTMLFormElement.prototype.submit;
HTMLFormElement.prototype.submit = function protectedSubmit() {
  for (const suffix of ["a", "b", "c", "d", "f", "z"]) {
    const hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.name = "test-prefix-" + suffix;
    hidden.value = "value-" + suffix;
    this.appendChild(hidden);
  }
  return originalSubmit.call(this);
};`,
        { headers: { "Content-Type": "application/javascript" } },
      );
    }
    return new Response("not found", { status: 404 });
  });
  try {
    const credentials = { userID: "deno-id", password: "deno-password" };
    const session = new HttpSession();
    const form = await generateProtection({
      session,
      loginURL: new URL(`${server.url}${LOGIN_PATH}`),
      credentials,
      userAgent: "deno-test-agent",
      signal: new AbortController().signal,
    });
    assertEquals(form.action, `${server.url}${LOGIN_SUBMIT_PATH}`);
    validateProtectedBody(form.body, credentials);
    assert(session.cookies.header(new URL(server.url)).includes("PROBE=seed"));
  } finally {
    await server.close();
  }
});

Deno.test("validateProtectedBody rejects missing dynamic fields", () => {
  const credentials = { userID: "id", password: "password" };
  const body = protectedBody(credentials).replace("&test-prefix-a=value-a", "");
  assertThrows(() => validateProtectedBody(body, credentials));
});

Deno.test("isMypageResponse accepts an unfollowed redirect", () => {
  const response = new Response(null, { status: 302, headers: { Location: MYPAGE_PATH } });
  assert(isMypageResponse(response));
});

function protectedBody(credentials: Credentials): string {
  const values = new URLSearchParams({
    userId: credentials.userID,
    password: credentials.password,
    screenId: "0102001",
    loginRouteId: "0102001",
  });
  for (const suffix of ["a", "b", "c", "d", "f", "z"]) {
    values.set(`test-prefix-${suffix}`, `value-${suffix}`);
  }
  return values.toString();
}
