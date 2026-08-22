import { assertEquals } from "@std/assert/";
import {
  isEmptyOrderPage,
  orderToCashOut,
  parseOrderDetail,
  parseOrderDetailAmount,
  parseOrderPage,
} from "./parser.ts";

const orderCard = `
<div class="order-card js-order-card">
  <div class="order-header">
    <div class="order-header__header-list-item">
      <div class="a-row">注文日</div><div class="a-row a-size-base">2026年8月20日</div>
    </div>
    <div class="order-header__header-list-item yohtmlc-order-total">
      <div class="a-row">合計</div><div class="a-row a-size-base">￥1,280</div>
    </div>
    <div class="yohtmlc-order-id"><span>注文番号</span><span dir="ltr">123-4567890-1234567</span></div>
  </div>
  <div class="delivery-box__primary-text">8月21日にお届け済み</div>
  <div class="yohtmlc-product-title"><a>ほしいも 500g</a></div>
</div>`;

Deno.test("parseOrderPage parses an Amazon.co.jp order card", () => {
  const parsed = parseOrderPage(`<main>${orderCard}</main>`);
  assertEquals(parsed.cardCount, 1);
  assertEquals(parsed.orders.length, 1);
  assertEquals(parsed.orders[0]?.id, "123-4567890-1234567");
  assertEquals(parsed.orders[0]?.occurredAt.toISOString(), "2026-08-19T15:00:00.000Z");
  assertEquals(parsed.orders[0]?.amount, 1280);
  assertEquals(parsed.orders[0]?.itemTitles, ["ほしいも 500g"]);

  const cashOut = orderToCashOut(parsed.orders[0]!, "amazon-wallet");
  assertEquals(cashOut.id, "amazon:123-4567890-1234567");
  assertEquals(cashOut.from, "amazon-wallet");
  assertEquals(cashOut.to.metadata.source, "amazon");
});

Deno.test("parseOrderPage extracts HTML from AmazonUI streaming JSON", () => {
  const payload = JSON.stringify(["append", "#ordersContainer", orderCard]);
  const parsed = parseOrderPage(payload);
  assertEquals(parsed.cardCount, 1);
  assertEquals(parsed.orders.map((order) => order.id), ["123-4567890-1234567"]);
});

Deno.test("parseOrderPage parses mobile purchase tiles from an AUI stream", () => {
  const tile = `
    <li><div class="a-box past-purchase-tile"><div class="a-box-inner">
      <a class="item-card__link"
         href="/your-orders/pop?orderId=503-1234567-7654321&amp;lineItemId=1"
         aria-label="テスト商品, 注文日 2026年8月20日"></a>
      <div class="past-purchase-tile__asin-information-primary-text-container">
        <span class="item-card__primary-text">テスト商品</span>
      </div>
      <div class="past-purchase-tile__asin-information-secondary-text-container">
        8月21日にお届け済み
      </div>
    </div></div></li>`;
  const payload = [
    JSON.stringify(["state", "chunkState", { nextStartIndex: 10 }]),
    JSON.stringify(["append", "div.past-purchases-refreshed-container", tile]),
  ].join("&&&\n");
  const parsed = parseOrderPage(payload);
  assertEquals(parsed.cardCount, 1);
  assertEquals(parsed.orders, []);
  assertEquals(parsed.references, [{
    id: "503-1234567-7654321",
    occurredAt: new Date("2026-08-19T15:00:00.000Z"),
    itemTitles: ["テスト商品"],
    status: "8月21日にお届け済み",
    canceled: false,
    detailPath: "/gp/aw/ya?ac=od&oid=503-1234567-7654321",
  }]);
});

Deno.test("parseOrderPage keeps physical mobile tiles whose list only has a delivery date", () => {
  const tile = `
    <div class="past-purchase-tile">
      <a class="item-card__link"
         href="/your-orders/pop?orderId=503-1234567-7654321"
         aria-label="テスト商品, 8月21日にお届け済み"></a>
      <span class="item-card__primary-text">テスト商品</span>
      <div class="past-purchase-tile__asin-information-secondary-text-container">
        8月21日にお届け済み
      </div>
    </div>`;
  const parsed = parseOrderPage(tile);
  assertEquals(parsed.cardCount, 1);
  assertEquals(parsed.references.length, 1);
  assertEquals(parsed.references[0]?.id, "503-1234567-7654321");
  assertEquals(parsed.references[0]?.occurredAt, undefined);
});

Deno.test("parseOrderDetailAmount prefers the billed amount from mobile details", () => {
  const detail = `
    <div class="a-row od-line-item-row">
      <div class="od-line-item-row-label">注文合計：</div>
      <div class="od-line-item-row-content">￥1,280</div>
    </div>
    <div class="a-row od-line-item-row">
      <div class="od-line-item-row-label">ご請求額：</div>
      <div class="od-line-item-row-content">￥1,000</div>
    </div>`;
  assertEquals(parseOrderDetailAmount(detail), 1000);
});

Deno.test("parseOrderDetailAmount parses the digital-order total label", () => {
  const detail = `
    <div class="a-row od-line-item-row">
      <div class="od-line-item-row-label">この注文の合計:</div>
      <div class="od-line-item-row-content"><span class="a-price">￥980</span></div>
    </div>`;
  assertEquals(parseOrderDetailAmount(detail), 980);
});

Deno.test("parseOrderDetailAmount sums split charges when they reconcile to the order total", () => {
  const detail = `
    <div class="od-line-item-row">
      <div class="od-line-item-row-label">ご請求額：</div>
      <div class="od-line-item-row-content">￥400</div>
    </div>
    <div class="od-line-item-row">
      <div class="od-line-item-row-label">ご請求額：</div>
      <div class="od-line-item-row-content">￥600</div>
    </div>
    <div class="od-line-item-row">
      <div class="od-line-item-row-label">注文合計：</div>
      <div class="od-line-item-row-content">￥1,000</div>
    </div>`;
  assertEquals(parseOrderDetailAmount(detail), 1000);
});

Deno.test("parseOrderDetailAmount does not double-count duplicated charge rows", () => {
  const detail = `
    <div class="od-line-item-row">
      <div class="od-line-item-row-label">ご請求額：</div>
      <div class="od-line-item-row-content">￥1,000</div>
    </div>
    <div class="od-line-item-row">
      <div class="od-line-item-row-label">ご請求額：</div>
      <div class="od-line-item-row-content">￥1,000</div>
    </div>
    <div class="od-line-item-row">
      <div class="od-line-item-row-label">注文合計：</div>
      <div class="od-line-item-row-content">￥1,000</div>
    </div>`;
  assertEquals(parseOrderDetailAmount(detail), 1000);
});

Deno.test("parseOrderDetailAmount rejects irreconcilable multiple charges", () => {
  const detail = `
    <div class="od-line-item-row">
      <div class="od-line-item-row-label">ご請求額：</div>
      <div class="od-line-item-row-content">￥400</div>
    </div>
    <div class="od-line-item-row">
      <div class="od-line-item-row-label">ご請求額：</div>
      <div class="od-line-item-row-content">￥500</div>
    </div>
    <div class="od-line-item-row">
      <div class="od-line-item-row-label">注文合計：</div>
      <div class="od-line-item-row-content">￥1,000</div>
    </div>`;
  assertEquals(parseOrderDetailAmount(detail), undefined);
});

Deno.test("parseOrderDetail obtains the physical order date", () => {
  const detail = `
    <div><span>注文日 2026年8月17日</span></div>
    <div class="od-line-item-row">
      <div class="od-line-item-row-label">ご請求額：</div>
      <div class="od-line-item-row-content">￥756</div>
    </div>`;
  assertEquals(parseOrderDetail(detail), {
    amount: 756,
    occurredAt: new Date("2026-08-16T15:00:00.000Z"),
  });
});

Deno.test("parseOrderPage marks canceled orders", () => {
  const parsed = parseOrderPage(
    orderCard.replace("8月21日にお届け済み", "注文はキャンセルされました"),
  );
  assertEquals(parsed.orders[0]?.canceled, true);
});

Deno.test("isEmptyOrderPage recognizes an explicit empty history", () => {
  assertEquals(isEmptyOrderPage("<div>この期間に該当するご注文はありません。</div>"), true);
  assertEquals(isEmptyOrderPage("<main>注文履歴</main>"), false);
});
