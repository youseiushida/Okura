import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert/";
import { createWallet } from "../../model/account.ts";
import { YuchoDebitAdapter } from "./adapter.ts";
import { createYuchoDebitContext } from "./context.ts";
import { PeriodUnavailableError, UnauthenticatedError, YuchoDebitError } from "./errors.ts";
import { HOME_PATH, STATEMENT_DETAIL_PATH, STATEMENT_INDEX_PATH } from "./routes.ts";
import {
  authenticatedHomeHTML,
  expiredHTML,
  jstDate,
  startTestServer,
  statementIndexHTML,
  statementPageHTML,
  type TestTransaction,
} from "./test_util.ts";

Deno.test("YuchoDebitAdapter fetches and filters all Nablarch statement pages", async () => {
  const transactions = Array.from({ length: 12 }, (_, index): TestTransaction => ({
    date: `2026/08/${String(12 - index).padStart(2, "0")}`,
    merchant: `SHOP ${12 - index}`,
    transactionAmount: `JPY ${100 + index}.00`,
    approvalNumber: String(100000 + index),
  }));
  let detailRequests = 0;
  let serverURL = "";
  const server = startTestServer(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === HOME_PATH) {
      assertEquals(request.method, "GET");
      assertEquals(url.searchParams.get("cc"), "01010");
      assertEquals(request.headers.get("User-Agent"), "test-agent");
      return html(authenticatedHomeHTML("home-state"));
    }
    if (url.pathname === STATEMENT_INDEX_PATH) {
      assertEquals(request.method, "POST");
      assertEquals(request.headers.get("Origin"), serverURL);
      const body = new URLSearchParams(await request.text());
      assertEquals(body.get("nablarch_hidden"), "home-state");
      assertEquals(body.get("nablarch_submit"), "nablarch_form3_2");
      return html(statementIndexHTML([
        { year: 2026, month: 8, referenceDate: "20260824" },
        { year: 2026, month: 7, referenceDate: "20260724" },
      ]));
    }
    if (url.pathname === STATEMENT_DETAIL_PATH) {
      detailRequests += 1;
      assertEquals(request.method, "POST");
      const body = new URLSearchParams(await request.text());
      if (detailRequests === 1) {
        assertEquals(body.get("W131301.referenceDate"), "20260824");
        assertEquals(body.get("nablarch_hidden"), "month-state");
        assertEquals(body.get("nablarch_submit"), "nablarch_form4_1");
        return html(statementPageHTML({
          resultCount: 12,
          currentPage: 1,
          totalPages: 2,
          transactions: transactions.slice(0, 10),
        }));
      }
      assertEquals(body.get("nablarch_hidden"), "page-1-state");
      assertEquals(body.get("nablarch_submit"), "nextSubmit");
      return html(statementPageHTML({
        resultCount: 12,
        currentPage: 2,
        totalPages: 2,
        transactions: transactions.slice(10),
      }));
    }
    return new Response("not found", { status: 404 });
  });
  serverURL = server.url;
  try {
    const { context, adapter } = adapterFor(server.url);
    const cashOuts = await adapter.fetchCashOuts({
      from: jstDate(2026, 8, 2),
      to: jstDate(2026, 9, 1),
    });

    assertEquals(detailRequests, 2);
    assertEquals(cashOuts.length, 11);
    assertEquals(
      cashOuts.map((item) => item.occurredAt),
      Array.from({ length: 11 }, (_, index) => jstDate(2026, 8, index + 2)),
    );
    assertEquals(cashOuts[0]?.from.connectionID, context.connection.id);
    assertEquals(cashOuts[0]?.to.name, "SHOP 2");
    assertEquals(cashOuts.at(-1)?.to.name, "SHOP 12");
  } finally {
    await server.close();
  }
});

Deno.test("YuchoDebitAdapter rejects periods older than the provider selector", async () => {
  const server = startTestServer(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === HOME_PATH) return html(authenticatedHomeHTML());
    if (url.pathname === STATEMENT_INDEX_PATH) {
      await request.body?.cancel();
      return html(statementIndexHTML([
        { year: 2026, month: 8, referenceDate: "20260824" },
        { year: 2026, month: 7, referenceDate: "20260724" },
      ]));
    }
    return new Response("unexpected", { status: 500 });
  });
  try {
    const { adapter } = adapterFor(server.url);
    await assertRejects(
      () => adapter.fetchCashOuts({ from: jstDate(2026, 6, 30), to: jstDate(2026, 8, 1) }),
      PeriodUnavailableError,
    );
  } finally {
    await server.close();
  }
});

Deno.test("YuchoDebitAdapter expires only a confirmed logged-out session", async () => {
  const server = startTestServer(() => html(expiredHTML()));
  try {
    const { context, adapter } = adapterFor(server.url);
    await assertRejects(
      () => adapter.fetchCashOuts({ from: jstDate(2026, 8, 1), to: jstDate(2026, 9, 1) }),
      UnauthenticatedError,
    );
    assertEquals(context.authenticationState, "expired");
  } finally {
    await server.close();
  }
});

Deno.test("YuchoDebitAdapter preserves valid state on an ambiguous 403", async () => {
  const { context, adapter } = adapterFor(
    undefined,
    () => Promise.resolve(new Response("forbidden", { status: 403 })),
  );
  await assertRejects(
    () => adapter.fetchCashOuts({ from: jstDate(2026, 8, 1), to: jstDate(2026, 9, 1) }),
    YuchoDebitError,
    "unexpected HTTP 403",
  );
  assertEquals(context.authenticationState, "valid");
});

Deno.test("YuchoDebitAdapter rejects a spoofed authenticated page at another origin", async () => {
  const { context, adapter } = adapterFor(undefined, () =>
    Promise.resolve(responseAt(
      "https://example.com/p/login/RW1312010201?cc=01010",
      authenticatedHomeHTML(),
    )));
  await assertRejects(
    () => adapter.fetchCashOuts({ from: jstDate(2026, 8, 1), to: jstDate(2026, 9, 1) }),
    YuchoDebitError,
    "unexpected URL",
  );
  assertEquals(context.authenticationState, "valid");
});

Deno.test("YuchoDebitAdapter preserves AbortSignal reasons", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled", "AbortError");
  controller.abort(reason);
  const { adapter } = adapterFor(undefined, (_input, init) => {
    init?.signal?.throwIfAborted();
    return Promise.reject(new Error("request should have been aborted"));
  });

  const error = await assertRejects(() =>
    adapter.fetchCashOuts(
      { from: jstDate(2026, 8, 1), to: jstDate(2026, 9, 1) },
      { signal: controller.signal },
    )
  );
  assertStrictEquals(error, reason);
});

function adapterFor(
  baseURL?: string,
  fetcher?: (input: URL | Request | string, init?: RequestInit) => Promise<Response>,
) {
  const context = createYuchoDebitContext({ baseURL, fetch: fetcher });
  context.authenticationState = "valid";
  context.userAgent = "test-agent";
  const wallet = createWallet(context.connection, "wallet-yucho-debit", "ゆうちょデビット");
  return { context, adapter: new YuchoDebitAdapter(context, { wallet }) };
}

function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
}

function responseAt(url: string, body: string): Response {
  const response = html(body);
  Object.defineProperty(response, "url", { value: url });
  return response;
}
