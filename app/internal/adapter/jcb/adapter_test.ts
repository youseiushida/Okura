import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert/";
import { createWallet } from "../../model/account.ts";
import { DETAIL_MENU_LINK_ID, DETAIL_MENU_PATH, DETAIL_PATH, JCBAdapter } from "./adapter.ts";
import { createJCBContext } from "./context.ts";
import { JCBAuthentication } from "./authentication.ts";
import { MYPAGE_PATH } from "./login.ts";
import { PeriodUnavailableError, UnauthenticatedError } from "./errors.ts";
import { parseStatement, statementSequences } from "./parser.ts";
import {
  jstDate,
  startTestServer,
  statementHTML,
  statementHTMLWithDifferences,
} from "./test_util.ts";

Deno.test("JCBAdapter.fetchCashFlows maps settled and difference refunds", async () => {
  // Minimized from the observed MyJCB table shapes. All transaction values are synthetic.
  const requestedSequences: string[] = [];
  let menuRequests = 0;
  let serverURL = "";
  const server = startTestServer((request) => {
    const url = new URL(request.url);
    if (url.pathname === DETAIL_MENU_PATH) {
      menuRequests += 1;
      assertEquals(url.searchParams.get("link_id"), DETAIL_MENU_LINK_ID);
      assertEquals(request.headers.get("Referer"), `${serverURL}${MYPAGE_PATH}`);
      return new Response("<html><body>menu</body></html>");
    }
    assertEquals(url.pathname, DETAIL_PATH);
    requestedSequences.push(url.searchParams.get("seq") ?? "");
    assertEquals(
      request.headers.get("Referer"),
      `${serverURL}${DETAIL_MENU_PATH}?link_id=${DETAIL_MENU_LINK_ID}`,
    );
    return new Response(
      statementHTMLWithDifferences(
        [
          ["1234", "2026/06/16", "ACME &amp; STORE", "1,234", "海外利用", "654321"],
          ["1234", "2026/06/17", "RETURNED STORE", "-500", "", "654322"],
          ["1234", "2026/07/16", "OUT OF PERIOD", "999", "", "111111"],
        ],
        [
          ["1234", "2026/06/18", "ADJUSTED STORE", "250", "", "銀行振替済", "654323"],
          ["1234", "2026/06/19", "DIFFERENCE RETURN", "-100", "", "銀行振替済", "654324"],
        ],
      ),
      { headers: { "Content-Type": "text/html; charset=UTF-8" } },
    );
  });
  serverURL = server.url;
  try {
    const context = createJCBContext({ baseURL: server.url });
    context.authenticationState = "valid";
    context.userAgent = "test-agent";
    const adapter = new JCBAdapter(context, {
      wallet: createWallet(context.connection, "wallet-jcb", "My JCB"),
      now: () => jstDate(2026, 8, 22, 12),
    });
    const result = await adapter.fetchCashFlows({
      from: jstDate(2026, 6, 16),
      to: jstDate(2026, 7, 16),
    });
    assertEquals(menuRequests, 1);
    assertEquals(requestedSequences, ["2"]);
    assertEquals(result.cashOuts.length, 2);
    assertEquals(result.cashIns.length, 2);
    const cashOut = result.cashOuts[0];
    assert(cashOut !== undefined);
    assertEquals(cashOut.amount, 1234);
    assertEquals(cashOut.from.name, "My JCB");
    assertEquals(cashOut.to.name, "ACME & STORE");
    assertEquals(cashOut.to.metadata.approval_number, "654321");
    assertEquals(cashOut.to.metadata.description, "海外利用");
    assertMatch(cashOut.id, /^jcb\/default:transaction:[0-9a-f]{64}$/);
    assertEquals(result.cashOuts[1]?.amount, 250);
    assertEquals(result.cashOuts[1]?.to.metadata.statement_section, "difference");
    assertEquals(result.cashOuts[1]?.to.metadata.status, "銀行振替済");
    assertEquals(result.cashIns[0]?.amount, 500);
    assertEquals(result.cashIns[0]?.from.name, "RETURNED STORE");
    assertEquals(result.cashIns[1]?.amount, 100);
    assertEquals(result.cashIns[1]?.from.metadata.statement_section, "difference");
  } finally {
    await server.close();
  }
});

Deno.test("JCBAdapter.fetchCashFlows detects a login redirect", async () => {
  const server = startTestServer((request) => {
    if (new URL(request.url).pathname === "/Login") return new Response("login");
    return Response.redirect(new URL("/Login", request.url), 302);
  });
  try {
    const context = createJCBContext({ baseURL: server.url });
    context.authenticationState = "valid";
    const adapter = new JCBAdapter(context, {
      wallet: createWallet(context.connection, "wallet-jcb", "My JCB"),
      now: () => jstDate(2026, 8, 22, 12),
    });
    const error = await assertRejects(() =>
      adapter.fetchCashFlows({
        from: jstDate(2026, 8, 16),
        to: jstDate(2026, 8, 17),
      })
    );
    assert(error instanceof UnauthenticatedError);
    assertEquals(context.authenticationState, "expired");
    assertThrows(() => new JCBAuthentication(context).captureSession(), TypeError);
  } finally {
    await server.close();
  }
});

Deno.test("JCBAdapter does not expire a session on an ambiguous 403", async () => {
  const context = createJCBContext({
    fetch: (input) =>
      Promise.resolve(responseAt(
        new URL(input instanceof Request ? input.url : input).href,
        "forbidden",
        403,
      )),
  });
  context.authenticationState = "valid";
  const adapter = new JCBAdapter(context, {
    wallet: createWallet(context.connection, "wallet-jcb", "My JCB"),
    now: () => jstDate(2026, 8, 22, 12),
  });

  await assertRejects(() =>
    adapter.fetchCashFlows({
      from: jstDate(2026, 8, 16),
      to: jstDate(2026, 8, 17),
    })
  );
  assertEquals(context.authenticationState, "valid");
});

Deno.test("JCBAdapter preserves AbortSignal reason", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled", "AbortError");
  controller.abort(reason);
  const context = createJCBContext({
    fetch: (_input, init) => {
      init?.signal?.throwIfAborted();
      return Promise.reject(new Error("request should have been aborted"));
    },
  });
  context.authenticationState = "valid";
  const adapter = new JCBAdapter(context, {
    wallet: createWallet(context.connection, "wallet-jcb", "My JCB"),
    now: () => jstDate(2026, 8, 22, 12),
  });
  const error = await assertRejects(() =>
    adapter.fetchCashFlows(
      { from: jstDate(2026, 8, 16), to: jstDate(2026, 8, 17) },
      { signal: controller.signal },
    )
  );
  assertStrictEquals(error, reason);
});

Deno.test("statementSequences validates the available 15 cycles", () => {
  const now = jstDate(2026, 8, 22, 12);
  assertEquals(
    statementSequences({
      from: jstDate(2026, 6, 16),
      to: jstDate(2026, 7, 16),
    }, now),
    [2],
  );
  assertEquals(
    statementSequences({
      from: jstDate(2026, 6, 16),
      to: jstDate(2026, 6, 16),
    }, now),
    [],
  );
  assertThrows(() =>
    statementSequences({
      from: jstDate(2025, 5, 15),
      to: jstDate(2025, 5, 16),
    }, now), PeriodUnavailableError);
});

Deno.test("parseStatement preserves observed signed refunds and duplicate IDs", () => {
  const parsed = parseStatement(statementHTML(
    ["1234", "2026/06/16", "SHOP", "1,000", "", "123456"],
    ["1234", "2026/06/16", "SHOP", "1,000", "", "123456"],
    ["1234", "2026/06/17", "REFUND", "-500", "", "654321"],
  ));
  assert(parsed.found);
  assertEquals(parsed.rows.length, 3);
  assertEquals(parsed.rows[0]?.amount, 1000);
  assertEquals(parsed.rows[2]?.amount, -500);
  assertNotEquals(parsed.rows[0]?.id, parsed.rows[1]?.id);
});

function responseAt(url: string, body: string, status = 200): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
