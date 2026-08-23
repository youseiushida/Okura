import { assertEquals } from "@std/assert/";
import type { OtpChallengeRequest } from "../../port/auth_interaction.ts";
import { createMoneyForwardContext } from "./context.ts";
import { performLogin } from "./login.ts";

Deno.test("performLogin follows Money Forward ID email OTP without executing page scripts", async () => {
  const requested: string[] = [];
  const challenges: OtpChallengeRequest[] = [];
  const context = createMoneyForwardContext({
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      requested.push(`${method} ${url.origin}${url.pathname}`);
      if (
        method === "GET" && url.origin === "https://moneyforward.com" && url.pathname === "/sign_in"
      ) {
        return Promise.resolve(responseAt(oauthURL("/sign_in"), authHTML("csrf-email")));
      }
      if (method === "POST" && url.pathname === "/sign_in/email") {
        assertOAuthForm(init?.body, {
          authenticity_token: "csrf-email",
          "mfid_user[email]": "person@example.com",
          "mfid_user[password]": "",
        });
        return Promise.resolve(
          responseAt(oauthURL("/sign_in/password"), authHTML("csrf-password")),
        );
      }
      if (method === "POST" && url.pathname === "/sign_in") {
        assertOAuthForm(init?.body, {
          authenticity_token: "csrf-password",
          "mfid_user[email]": "person@example.com",
          "mfid_user[password]": "password",
        });
        return Promise.resolve(responseAt(oauthURL("/email_otp"), authHTML("csrf-otp")));
      }
      if (method === "POST" && url.pathname === "/email_otp") {
        assertOAuthForm(init?.body, {
          authenticity_token: "csrf-otp",
          email_otp: "123456",
        });
        return Promise.resolve(
          responseAt(oauthURL("/passkey_promotion"), authHTML("csrf-passkey")),
        );
      }
      if (method === "POST" && url.pathname === "/passkey_promotion/collect") {
        assertEquals(url.searchParams.get("event"), "passkey_rejected");
        assertEquals(new Headers(init?.headers).get("X-CSRF-Token"), "csrf-passkey");
        return Promise.resolve(responseAt(url.href, "", 204));
      }
      if (method === "GET" && url.pathname === "/passkey_promotion/finalize_passkey_setup") {
        assertEquals(url.searchParams.get("clientId"), "client-id");
        return Promise.resolve(responseAt("https://moneyforward.com/", "<html>home</html>"));
      }
      if (method === "GET" && url.origin === "https://moneyforward.com" && url.pathname === "/cf") {
        return Promise.resolve(responseAt(
          url.href,
          `
          <meta name="csrf-token" content="csrf-cf">
          <body class="cf_controller index_action"><form action="/cf/create"></form></body>`,
        ));
      }
      throw new Error(`unexpected request ${method} ${url}`);
    },
  });

  await performLogin(context, { email: "person@example.com", password: "password" }, {
    interaction: {
      otp: {
        request: (challenge) => {
          challenges.push(challenge);
          return Promise.resolve({ action: "submit", code: "123456" });
        },
      },
      progress: { publish: () => Promise.resolve() },
    },
  });

  assertEquals(challenges, [{
    provider: "moneyforward",
    step: "login-email-otp",
    attempt: 1,
    channel: "email",
    destinationHint: "p***@example.com",
    format: "numeric",
    length: { min: 6, max: 6 },
    resend: { allowed: false },
  }]);
  assertEquals(requested.some((value) => /assets-id|bundled/.test(value)), false);
  assertEquals(requested.at(-1), "GET https://moneyforward.com/cf");
});

Deno.test("performLogin accepts an OTP flow that returns directly to Money Forward", async () => {
  const requested: string[] = [];
  const context = createMoneyForwardContext({
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      requested.push(`${method} ${url.origin}${url.pathname}`);
      if (
        method === "GET" && url.origin === "https://moneyforward.com" &&
        url.pathname === "/sign_in"
      ) {
        return Promise.resolve(responseAt(oauthURL("/sign_in"), authHTML("csrf-email")));
      }
      if (method === "POST" && url.pathname === "/sign_in/email") {
        return Promise.resolve(responseAt(
          oauthURL("/sign_in/password"),
          authHTML("csrf-password"),
        ));
      }
      if (method === "POST" && url.pathname === "/sign_in") {
        return Promise.resolve(responseAt(oauthURL("/email_otp"), authHTML("csrf-otp")));
      }
      if (method === "POST" && url.pathname === "/email_otp") {
        return Promise.resolve(responseAt("https://moneyforward.com/", "<html>home</html>"));
      }
      if (
        method === "GET" && url.origin === "https://moneyforward.com" && url.pathname === "/cf"
      ) {
        return Promise.resolve(responseAt(
          url.href,
          `<meta name="csrf-token" content="csrf-cf">
           <body class="cf_controller index_action"><form action="/cf/create"></form></body>`,
        ));
      }
      throw new Error(`unexpected request ${method} ${url}`);
    },
  });

  await performLogin(context, { email: "person@example.com", password: "password" }, {
    interaction: {
      otp: { request: () => Promise.resolve({ action: "submit", code: "123456" }) },
      progress: { publish: () => Promise.resolve() },
    },
  });

  assertEquals(
    requested.some((value) => value.includes("/passkey_promotion")),
    false,
  );
  assertEquals(requested.at(-1), "GET https://moneyforward.com/cf");
});

function assertOAuthForm(
  body: BodyInit | null | undefined,
  expected: Record<string, string>,
): void {
  const parameters = body as URLSearchParams;
  for (const [name, value] of Object.entries(expected)) assertEquals(parameters.get(name), value);
  assertEquals(parameters.get("_method"), "post");
  assertEquals(parameters.get("clientId"), "client-id");
  assertEquals(parameters.get("redirectUri"), "https://moneyforward.com/auth/mfid/callback");
  assertEquals(parameters.get("responseType"), "code");
  assertEquals(parameters.get("scope"), "openid email");
  assertEquals(parameters.get("state"), "state-value");
  assertEquals(parameters.get("codeChallenge"), "challenge-value");
  assertEquals(parameters.get("codeChallengeMethod"), "S256");
  assertEquals(parameters.get("nonce"), "nonce-value");
}

function oauthURL(path: string): string {
  const url = new URL(path, "https://id.moneyforward.com");
  url.search = new URLSearchParams({
    client_id: "client-id",
    redirect_uri: "https://moneyforward.com/auth/mfid/callback",
    response_type: "code",
    scope: "openid email",
    state: "state-value",
    code_challenge: "challenge-value",
    code_challenge_method: "S256",
    nonce: "nonce-value",
  }).toString();
  return url.href;
}

function authHTML(csrf: string): string {
  return `<html><head><meta name="csrf-token" content="${csrf}"></head>
    <body><main id="js-page"></main><script>globalThis.compromised = true;</script></body></html>`;
}

function responseAt(url: string, body: string, status = 200): Response {
  const response = new Response(status === 204 ? null : body, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
