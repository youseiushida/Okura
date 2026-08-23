import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert/";
import { createWallet } from "../../model/account.ts";
import { AuthenticationRequiredError } from "../../port/source.ts";
import { AmazonAdapter } from "./adapter.ts";
import { AmazonAuthentication } from "./authentication.ts";
import { createAmazonContext } from "./context.ts";
import { UnexpectedPageError } from "./errors.ts";

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

Deno.test("AmazonAdapter follows the explicit pagination cursor", async () => {
  const requestedStartIndices: Array<string | null> = [];
  const context = createAmazonContext({
    fetch: (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const startIndex = url.searchParams.get("startIndex");
      requestedStartIndices.push(startIndex);
      const payload = startIndex === null
        ? orderPage(1, 10, 10)
        : startIndex === "10"
        ? orderPage(11, 9, 20)
        : orderPage(20, 1);
      return Promise.resolve(responseAt(url.href, payload));
    },
  });
  context.authenticationState = "valid";

  const cashOuts = await adapterFor(context).fetchCashOuts({
    from: new Date("2026-07-31T15:00:00.000Z"),
    to: new Date("2026-08-31T15:00:00.000Z"),
  });

  assertEquals(requestedStartIndices, [null, "10", "20"]);
  assertEquals(cashOuts.length, 20);
});

Deno.test("AmazonAdapter rejects a pagination cursor that does not advance", async () => {
  const context = createAmazonContext({
    fetch: (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return Promise.resolve(responseAt(url.href, orderPage(1, 1, 0)));
    },
  });
  context.authenticationState = "valid";

  await assertRejects(
    () => adapterFor(context).fetchCashOuts(period),
    UnexpectedPageError,
    "pagination cursor did not advance",
  );
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

function orderPage(firstOrder: number, count: number, nextStartIndex?: number): string {
  const cards = Array.from({ length: count }, (_, offset) => {
    const sequence = firstOrder + offset;
    const localID = String(sequence).padStart(7, "0");
    return `
      <div class="order-card" data-order-id="123-${localID}-${localID}">
        <div data-component="orderDate">注文日 2026年8月${sequence}日</div>
        <div data-component="orderTotal">合計 ￥${sequence}</div>
        <div data-component="itemTitle">商品${sequence}</div>
      </div>`;
  }).join("");
  const chunks: string[] = [];
  if (nextStartIndex !== undefined) {
    chunks.push(JSON.stringify(["state", "chunkState", { nextStartIndex }]));
  }
  chunks.push(JSON.stringify(["append", "#ordersContainer", cards]));
  return chunks.join("&&&\n");
}
