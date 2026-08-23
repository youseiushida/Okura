import { assertEquals, assertThrows } from "@std/assert/";
import { createProviderConnection } from "../../model/connection.ts";
import {
  assetIDFromName,
  cashFlowToCashIn,
  cashFlowToCashOut,
  extractCashFlowHTML,
  parseAssetBalances,
  parseCashFlows,
  parseTransfers,
  walletIDFromName,
} from "./parser.ts";

const connection = createProviderConnection("moneyforward", "personal");

Deno.test("parseAssetBalances reads every Money Forward portfolio row", () => {
  const observedAt = new Date("2026-08-23T06:00:00.000Z");
  const balances = parseAssetBalances(
    `
    <section class="bs-detail" id="portfolio_det_depo">
      <table class="table table-bordered table-depo">
        <tr><th>名称</th><th>金額</th><th>金融機関</th><th>編集</th><th>削除</th></tr>
        <tr><td>普通預金</td><td class="number">12,345円</td><td>セブン銀行</td><td></td><td></td></tr>
        <tr><td>普通預金</td><td class="number">−2,000円</td><td>ゆうちょ銀行</td><td></td><td></td></tr>
      </table>
    </section>
  `,
    observedAt,
    connection,
  );

  assertEquals(balances, [
    {
      asset: {
        id: assetIDFromName("普通預金", "セブン銀行", connection.id),
        connectionID: connection.id,
        name: "普通預金",
        metadata: { source: "moneyforward", kind: "portfolio", institution: "セブン銀行" },
      },
      amount: 12_345,
      observedAt,
    },
    {
      asset: {
        id: assetIDFromName("普通預金", "ゆうちょ銀行", connection.id),
        connectionID: connection.id,
        name: "普通預金",
        metadata: { source: "moneyforward", kind: "portfolio", institution: "ゆうちょ銀行" },
      },
      amount: -2_000,
      observedAt,
    },
  ]);
});

Deno.test("parseCashFlows maps income and expense to their wallets", () => {
  const html = transactionRow({
    id: "101",
    income: false,
    amount: "-1,280円",
    content: "食料品店",
    wallet: "財布・現金",
    date: "2026-08-03T00:00:00+09:00",
    largeCategory: "食費",
    middleCategory: "食料品",
  }) + transactionRow({
    id: "102",
    income: true,
    amount: "50,000円",
    content: "給与",
    wallet: "予備口座",
    date: "2026-08-20T00:00:00+09:00",
    largeCategory: "収入",
    middleCategory: "給与",
  });
  const flows = parseCashFlows(
    html,
    new Date("2026-07-31T15:00:00.000Z"),
    connection,
  );

  assertEquals(flows.length, 2);
  assertEquals(cashFlowToCashOut(flows[0]!), {
    id: `${connection.id}:transaction:user_asset_act:101`,
    connectionID: connection.id,
    amount: 1_280,
    occurredAt: new Date("2026-08-02T15:00:00.000Z"),
    from: {
      id: walletIDFromName("財布・現金", connection.id),
      connectionID: connection.id,
      name: "財布・現金",
      metadata: { source: "moneyforward" },
    },
    to: {
      name: "食料品店",
      metadata: {
        source: "moneyforward",
        table_name: "user_asset_act",
        target: "true",
        large_category: "食費",
        middle_category: "食料品",
      },
    },
  });
  assertEquals(cashFlowToCashIn(flows[1]!), {
    id: `${connection.id}:transaction:user_asset_act:102`,
    connectionID: connection.id,
    amount: 50_000,
    occurredAt: new Date("2026-08-19T15:00:00.000Z"),
    from: {
      name: "給与",
      metadata: {
        source: "moneyforward",
        table_name: "user_asset_act",
        target: "true",
        large_category: "収入",
        middle_category: "給与",
      },
    },
    to: {
      id: walletIDFromName("予備口座", connection.id),
      connectionID: connection.id,
      name: "予備口座",
      metadata: { source: "moneyforward" },
    },
  });
});

Deno.test("parseCashFlows preserves the aggregation target flag", () => {
  const [flow] = parseCashFlows(
    transactionRow({
      id: "103",
      income: false,
      target: false,
      amount: "-500円",
      content: "対象外",
      wallet: "セブン銀行",
      date: "2026-08-21T00:00:00+09:00",
      largeCategory: "未分類",
      middleCategory: "未分類",
    }),
    new Date("2026-07-31T15:00:00.000Z"),
    connection,
  );

  assertEquals(flow?.target, false);
});

Deno.test("parseTransfers reads source and destination wallets from a completed transfer row", () => {
  const [transfer] = parseTransfers(
    transferRow({
      id: "104",
      income: true,
      amount: "10,000円",
      content: "口座振替",
      fromWallet: "ゆうちょ銀行",
      toWallet: "セブン銀行",
      date: "2026-08-22T00:00:00+09:00",
    }),
    new Date("2026-07-31T15:00:00.000Z"),
    connection,
  );

  assertEquals(transfer, {
    id: `${connection.id}:transaction:user_asset_act:104`,
    connectionID: connection.id,
    tableName: "user_asset_act",
    kind: "transfer",
    amount: 10_000,
    occurredAt: new Date("2026-08-21T15:00:00.000Z"),
    from: {
      id: walletIDFromName("ゆうちょ銀行", connection.id),
      connectionID: connection.id,
      name: "ゆうちょ銀行",
      metadata: { source: "moneyforward" },
    },
    to: {
      id: walletIDFromName("セブン銀行", connection.id),
      connectionID: connection.id,
      name: "セブン銀行",
      metadata: { source: "moneyforward" },
    },
  });
});

Deno.test("an incomplete transfer is omitted instead of becoming ordinary cash flow", () => {
  const html = `
    <tr class="transaction_list js-cf-edit-container mf-grayout">
      <td><form action="/cf/update">
        <input name="user_asset_act[id]" value="105">
        <input name="user_asset_act[table_name]" value="user_asset_act">
        <input name="user_asset_act[is_income]" value="1">
      </form></td>
      <td class="date" data-table-sortable-value="2026-08-23T00:00:00+09:00">8/23</td>
      <td class="content">口座振替</td>
      <td class="amount">1,000円</td>
      <td class="calc"><div class="transfer_account_box_02">振替先
        <div class="transfer_account_box">セブン銀行</div>
      </div></td>
    </tr>`;
  const month = new Date("2026-07-31T15:00:00.000Z");

  assertEquals(parseCashFlows(html, month, connection), []);
  assertEquals(parseTransfers(html, month, connection), []);
});

Deno.test("extractCashFlowHTML decodes the HTML string without executing JavaScript", () => {
  const html = transactionRow({
    id: "201",
    income: false,
    amount: "-300円",
    content: "Bob's shop",
    wallet: "財布・現金",
    date: "2026-08-23T00:00:00+09:00",
    largeCategory: "その他",
    middleCategory: "その他",
  });
  const encoded = html.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n");
  const javascript = `globalThis.compromised = true; $("#cf-detail-table").append('${encoded}');`;

  assertEquals(extractCashFlowHTML(javascript), html);
  assertEquals((globalThis as Record<string, unknown>).compromised, undefined);
});

Deno.test("portfolio and cash-flow parsers reject missing structural markers", () => {
  assertThrows(() => parseAssetBalances("<html></html>", new Date(), connection), Error);
  assertThrows(() => extractCashFlowHTML("alert('empty')"), Error);
});

interface TransactionFixture {
  readonly id: string;
  readonly income: boolean;
  readonly target?: boolean;
  readonly amount: string;
  readonly content: string;
  readonly wallet: string;
  readonly date: string;
  readonly largeCategory: string;
  readonly middleCategory: string;
}

function transactionRow(value: TransactionFixture): string {
  return `
    <tr id="js-transaction-${value.id}" class="transaction_list js-cf-edit-container target-active">
      <td class="calc">
        <form action="/cf/update" method="post">
          <input name="user_asset_act[id]" type="hidden" value="${value.id}">
          <input name="user_asset_act[sub_account_id_hash]" type="hidden" value="">
          <input name="user_asset_act[table_name]" type="hidden" value="user_asset_act">
          <input name="user_asset_act[is_income]" type="hidden" value="${value.income ? 1 : 0}">
          <input name="user_asset_act[is_target]" type="hidden" value="${
    value.target === false ? 0 : 1
  }">
          <input name="user_asset_act[memo]" type="text" value="">
        </form>
      </td>
      <td class="date" data-table-sortable-value="${value.date}">8/23 (日)</td>
      <td class="content">${value.content}</td>
      <td class="number amount ${value.income ? "plus-color" : "minus-color"}">${value.amount}</td>
      <td class="note calc">${value.wallet}</td>
      <td class="lctg">${value.largeCategory}</td>
      <td class="mctg">${value.middleCategory}</td>
      <td class="memo"></td>
    </tr>`;
}

function transferRow(value: {
  readonly id: string;
  readonly income: boolean;
  readonly amount: string;
  readonly content: string;
  readonly fromWallet: string;
  readonly toWallet: string;
  readonly date: string;
}): string {
  return `
    <tr id="js-transaction-${value.id}" class="transaction_list js-cf-edit-container mf-grayout">
      <td class="calc">
        <form action="/cf/update" method="post">
          <input name="user_asset_act[id]" type="hidden" value="${value.id}">
          <input name="user_asset_act[sub_account_id_hash]" type="hidden" value="">
          <input name="user_asset_act[table_name]" type="hidden" value="user_asset_act">
          <input name="user_asset_act[is_income]" type="hidden" value="${value.income ? 1 : 0}">
        </form>
      </td>
      <td class="date" data-table-sortable-value="${value.date}">8/22 (土)</td>
      <td class="content">${value.content}</td>
      <td class="number amount">${value.amount}</td>
      <td class="calc">${value.fromWallet}<div class="transfer_account_box">${value.toWallet}</div></td>
      <td class="lctg"></td>
      <td class="mctg"></td>
      <td class="memo"></td>
    </tr>`;
}
