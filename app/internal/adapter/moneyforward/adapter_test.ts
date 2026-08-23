import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert/";
import { AuthenticationRequiredError } from "../../port/source.ts";
import { MoneyForwardAdapter } from "./adapter.ts";
import { MoneyForwardAuthentication } from "./authentication.ts";
import { createMoneyForwardContext } from "./context.ts";

Deno.test("MoneyForwardAdapter shares a fetch and separates target flows from transfers", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const context = createMoneyForwardContext({
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push({ url, init });
      if (url.pathname === "/bs/portfolio") {
        return Promise.resolve(responseAt(
          url.href,
          `
          <table class="table table-depo">
            <tr><th>名称</th><th>金額</th></tr>
            <tr><td>財布・現金</td><td class="number">10,000円</td><td>8月23日</td></tr>
          </table>`,
        ));
      }
      if (url.pathname === "/cf") {
        return Promise.resolve(responseAt(
          url.href,
          `
          <meta name="csrf-token" content="csrf-value">
          <body class="cf_controller index_action"><form action="/cf/create"></form></body>`,
        ));
      }
      if (url.pathname === "/cf/fetch") {
        const body = init?.body as URLSearchParams;
        assertEquals(body.get("from"), "2026/8/1");
        assertEquals(new Headers(init?.headers).get("X-CSRF-Token"), "csrf-value");
        const html = transactionRow({
          id: "301",
          income: false,
          amount: "-800円",
          content: "店",
          wallet: "財布・現金",
          date: "2026-08-10T00:00:00+09:00",
          largeCategory: "食費",
          middleCategory: "食料品",
        }) + transactionRow({
          id: "302",
          income: true,
          amount: "2,000円",
          content: "返金",
          wallet: "予備口座",
          date: "2026-08-11T00:00:00+09:00",
          largeCategory: "収入",
          middleCategory: "その他",
        }) + transactionRow({
          id: "303",
          income: false,
          target: false,
          amount: "-500円",
          content: "集計対象外",
          wallet: "財布・現金",
          date: "2026-08-12T00:00:00+09:00",
          largeCategory: "未分類",
          middleCategory: "未分類",
        }) + transferRow({
          id: "304",
          income: true,
          amount: "10,000円",
          content: "口座振替",
          fromWallet: "ゆうちょ銀行",
          toWallet: "セブン銀行",
          date: "2026-08-13T00:00:00+09:00",
        });
        return Promise.resolve(responseAt(url.href, `$("#table").append('${encodeJS(html)}');`));
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });
  context.authenticationState = "valid";
  const adapter = new MoneyForwardAdapter(context, {
    now: () => new Date("2026-08-23T06:00:00.000Z"),
  });

  const balances = await adapter.fetchAssetBalances();
  const period = {
    from: new Date("2026-07-31T15:00:00.000Z"),
    to: new Date("2026-08-31T15:00:00.000Z"),
  };
  const [cashIns, cashOuts, transfers] = await Promise.all([
    adapter.fetchCashIns(period),
    adapter.fetchCashOuts(period),
    adapter.fetchTransfers(period),
  ]);

  assertEquals(balances[0]?.amount, 10_000);
  assertEquals(cashIns[0]?.to.name, "予備口座");
  assertEquals(cashOuts[0]?.from.name, "財布・現金");
  assertEquals(cashIns.length, 1);
  assertEquals(cashOuts.length, 1);
  assertEquals(transfers.length, 1);
  assertEquals(transfers[0]?.from.name, "ゆうちょ銀行");
  assertEquals(transfers[0]?.to.name, "セブン銀行");
  assertEquals(cashIns[0]?.connectionID, context.connection.id);
  assertEquals(cashOuts[0]?.connectionID, context.connection.id);
  assertEquals(requests.map(({ url }) => url.pathname), ["/bs/portfolio", "/cf", "/cf/fetch"]);
});

Deno.test("MoneyForwardAdapter expires a confirmed logged-out session", async () => {
  const context = createMoneyForwardContext({
    fetch: () => Promise.resolve(responseAt("https://id.moneyforward.com/sign_in", "sign in")),
  });
  context.authenticationState = "valid";
  const adapter = new MoneyForwardAdapter(context);
  const error = await assertRejects(() => adapter.fetchAssetBalances());

  assertEquals(error instanceof AuthenticationRequiredError, true);
  assertEquals(context.authenticationState, "expired");
  assertThrows(() => new MoneyForwardAuthentication(context).captureSession(), TypeError);
});

Deno.test("MoneyForwardAdapter does not expire a session on an ambiguous 403", async () => {
  const context = createMoneyForwardContext({
    fetch: () =>
      Promise.resolve(responseAt("https://moneyforward.com/bs/portfolio", "forbidden", 403)),
  });
  context.authenticationState = "valid";

  await assertRejects(() => new MoneyForwardAdapter(context).fetchAssetBalances());
  assertEquals(context.authenticationState, "valid");
});

Deno.test("MoneyForwardAdapter preserves AbortSignal reason", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled", "AbortError");
  controller.abort(reason);
  const context = createMoneyForwardContext({
    fetch: (_input, init) => {
      init?.signal?.throwIfAborted();
      return Promise.reject(new Error("request should have been aborted"));
    },
  });
  context.authenticationState = "valid";
  const error = await assertRejects(() =>
    new MoneyForwardAdapter(context).fetchCashOuts(
      {
        from: new Date("2026-07-31T15:00:00.000Z"),
        to: new Date("2026-08-31T15:00:00.000Z"),
      },
      { signal: controller.signal },
    )
  );
  assertStrictEquals(error, reason);
});

function encodeJS(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n");
}

function transactionRow(value: {
  id: string;
  income: boolean;
  amount: string;
  content: string;
  wallet: string;
  date: string;
  largeCategory: string;
  middleCategory: string;
  target?: boolean;
}): string {
  return `<tr class="transaction_list"><td><form action="/cf/update">
    <input name="user_asset_act[id]" value="${value.id}">
    <input name="user_asset_act[sub_account_id_hash]" value="">
    <input name="user_asset_act[table_name]" value="user_asset_act">
    <input name="user_asset_act[is_income]" value="${value.income ? 1 : 0}">
    <input name="user_asset_act[is_target]" value="${value.target === false ? 0 : 1}">
    <input name="user_asset_act[memo]" value="">
  </form></td><td class="date" data-table-sortable-value="${value.date}">8/1</td>
  <td class="content">${value.content}</td><td class="amount">${value.amount}</td>
  <td class="note">${value.wallet}</td><td class="lctg">${value.largeCategory}</td>
  <td class="mctg">${value.middleCategory}</td></tr>`;
}

function transferRow(value: {
  id: string;
  income: boolean;
  amount: string;
  content: string;
  fromWallet: string;
  toWallet: string;
  date: string;
}): string {
  return `<tr class="transaction_list mf-grayout"><td><form action="/cf/update">
    <input name="user_asset_act[id]" value="${value.id}">
    <input name="user_asset_act[sub_account_id_hash]" value="">
    <input name="user_asset_act[table_name]" value="user_asset_act">
    <input name="user_asset_act[is_income]" value="${value.income ? 1 : 0}">
  </form></td><td class="date" data-table-sortable-value="${value.date}">8/1</td>
  <td class="content">${value.content}</td><td class="amount">${value.amount}</td>
  <td class="calc">${value.fromWallet}<div class="transfer_account_box">${value.toWallet}</div></td><td class="lctg"></td><td class="mctg"></td></tr>`;
}

function responseAt(url: string, body: string, status = 200): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
