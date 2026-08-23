import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert/";
import { DETAIL_MENU_LINK_ID, DETAIL_MENU_PATH, DETAIL_PATH, JCBAdapter } from "./adapter.ts";
import { createJCBContext } from "./context.ts";
import { MYPAGE_PATH } from "./login.ts";
import { PeriodUnavailableError, UnauthenticatedError } from "./errors.ts";
import { parseStatement, statementSequences } from "./parser.ts";
import { hasCause, jstDate, startTestServer, statementHTML } from "./test_util.ts";

Deno.test("JCBAdapter.fetchCashOuts fetches the matching statement cycle", async () => {
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
      statementHTML(
        ["1234", "2026/06/16", "ACME &amp; STORE", "1,234", "海外利用", "654321"],
        ["1234", "2026/07/16", "OUT OF PERIOD", "999", "", "111111"],
      ),
      { headers: { "Content-Type": "text/html; charset=UTF-8" } },
    );
  });
  serverURL = server.url;
  try {
    const context = createJCBContext({ baseURL: server.url });
    context.authenticationState = "valid";
    const adapter = new JCBAdapter(context, {
      walletID: "wallet-jcb",
      now: () => jstDate(2026, 8, 22, 12),
    });
    const cashOuts = await adapter.fetchCashOuts({
      from: jstDate(2026, 6, 16),
      to: jstDate(2026, 7, 16),
    });
    assertEquals(menuRequests, 1);
    assertEquals(requestedSequences, ["2"]);
    assertEquals(cashOuts.length, 1);
    const cashOut = cashOuts[0];
    assert(cashOut !== undefined);
    assertEquals(cashOut.amount, 1234);
    assertEquals(cashOut.from, "wallet-jcb");
    assertEquals(cashOut.to.name, "ACME & STORE");
    assertEquals(cashOut.to.metadata.approval_number, "654321");
    assertEquals(cashOut.to.metadata.description, "海外利用");
    assertMatch(cashOut.id, /^jcb:[0-9a-f]{64}$/);
  } finally {
    await server.close();
  }
});

Deno.test("JCBAdapter.fetchCashOuts detects a login redirect", async () => {
  const server = startTestServer((request) => {
    if (new URL(request.url).pathname === "/Login") return new Response("login");
    return Response.redirect(new URL("/Login", request.url), 302);
  });
  try {
    const context = createJCBContext({ baseURL: server.url });
    context.authenticationState = "valid";
    const adapter = new JCBAdapter(context, {
      walletID: "wallet-jcb",
      now: () => jstDate(2026, 8, 22, 12),
    });
    const error = await assertRejects(() =>
      adapter.fetchCashOuts({
        from: jstDate(2026, 8, 16),
        to: jstDate(2026, 8, 17),
      })
    );
    assert(hasCause(error, (candidate) => candidate instanceof UnauthenticatedError));
  } finally {
    await server.close();
  }
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

Deno.test("parseStatement skips refunds and keeps duplicate IDs unique", () => {
  const parsed = parseStatement(statementHTML(
    ["1234", "２０２６／０６／１６", "SHOP", "１，０００円", "", "123456"],
    ["1234", "２０２６／０６／１６", "SHOP", "１，０００円", "", "123456"],
    ["1234", "2026/06/17", "REFUND", "△500", "", "654321"],
  ));
  assert(parsed.found);
  assertEquals(parsed.rows.length, 2);
  assertEquals(parsed.rows[0]?.amount, 1000);
  assertNotEquals(parsed.rows[0]?.id, parsed.rows[1]?.id);
});
