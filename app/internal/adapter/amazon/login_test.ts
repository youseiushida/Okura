import { assertThrows } from "@std/assert/";
import { AuthenticationFailedError, UnexpectedPageError } from "./errors.ts";
import { validateAuthenticatedHistory } from "./login.ts";

const baseURL = new URL("https://www.amazon.co.jp");

Deno.test("validateAuthenticatedHistory accepts a recognizable order page", () => {
  validateAuthenticatedHistory(
    responseAt("https://www.amazon.co.jp/your-orders/orders?orderFilter=all"),
    '<main id="ordersContainer"><h1>注文履歴</h1></main>',
    baseURL,
  );
});

Deno.test("validateAuthenticatedHistory rejects error statuses", () => {
  assertThrows(
    () =>
      validateAuthenticatedHistory(
        responseAt("https://www.amazon.co.jp/your-orders/orders", 500),
        "<h1>注文履歴</h1>",
        baseURL,
      ),
    UnexpectedPageError,
    "HTTP 500",
  );
});

Deno.test("validateAuthenticatedHistory rejects another origin", () => {
  assertThrows(
    () =>
      validateAuthenticatedHistory(
        responseAt("https://other.example/your-orders/orders"),
        "<h1>注文履歴</h1>",
        baseURL,
      ),
    UnexpectedPageError,
    "unexpected page",
  );
});

Deno.test("validateAuthenticatedHistory rejects WAF and CAPTCHA pages", () => {
  for (
    const html of [
      '<div id="challenge-container">AWS WAF</div>',
      '<form><input name="guess"><img src="/captcha.jpg"></form>',
    ]
  ) {
    assertThrows(
      () =>
        validateAuthenticatedHistory(
          responseAt("https://www.amazon.co.jp/your-orders/orders"),
          html,
          baseURL,
        ),
      AuthenticationFailedError,
    );
  }
});

Deno.test("validateAuthenticatedHistory rejects an unrelated 200 page", () => {
  assertThrows(
    () =>
      validateAuthenticatedHistory(
        responseAt("https://www.amazon.co.jp/your-orders/orders"),
        "<h1>Amazon</h1><p>temporarily unavailable</p>",
        baseURL,
      ),
    UnexpectedPageError,
    "not recognizable",
  );
});

function responseAt(url: string, status = 200): Response {
  const response = new Response("", { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
