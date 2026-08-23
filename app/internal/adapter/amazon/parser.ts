import { parse } from "parse5";
import type { Wallet } from "../../model/account.ts";
import { scopedID } from "../../model/connection.ts";
import type { CashOut } from "../../model/transaction.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ORDER_ID_PATTERN = /\b(?:D\d{2}|\d{3})-\d{7}-\d{7}\b/i;

interface HtmlAttribute {
  name: string;
  value: string;
}

interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: HtmlAttribute[];
  childNodes?: HtmlNode[];
}

export interface AmazonOrder {
  id: string;
  occurredAt: Date;
  amount: number;
  itemTitles: string[];
  status: string;
  canceled: boolean;
}

export interface AmazonOrderReference {
  id: string;
  occurredAt?: Date;
  itemTitles: string[];
  status: string;
  canceled: boolean;
  detailPath: string;
}

export interface ParsedOrderDetail {
  amount?: number;
  occurredAt?: Date;
}

export interface ParsedOrderPage {
  orders: AmazonOrder[];
  references: AmazonOrderReference[];
  cardCount: number;
}

export function parseOrderPage(payload: string): ParsedOrderPage {
  const orders = new Map<string, AmazonOrder>();
  const references = new Map<string, AmazonOrderReference>();
  let cardCount = 0;
  for (const html of htmlDocuments(payload)) {
    const document = parse(html) as unknown as HtmlNode;
    const cards = descendants(document).filter(isOrderCard);
    cardCount = Math.max(cardCount, cards.length);
    for (const card of cards) {
      const reference = parseOrderReference(card);
      if (reference !== undefined && !references.has(reference.id)) {
        references.set(reference.id, reference);
      }
      const order = parseOrderCard(card);
      if (order !== undefined && !orders.has(order.id)) orders.set(order.id, order);
    }
  }
  return {
    orders: [...orders.values()],
    references: [...references.values()],
    cardCount: Math.max(cardCount, orders.size, references.size),
  };
}

export function parseOrderDetail(payload: string): ParsedOrderDetail {
  const amounts: number[] = [];
  const dates: Date[] = [];
  let ambiguousAmount = false;
  for (const html of htmlDocuments(payload)) {
    const document = parse(html) as unknown as HtmlNode;
    const dateNodes = descendants(document).filter((node) => {
      const text = normalizeText(textContent(node));
      return text.length <= 100 &&
        (attribute(node, "data-component") === "orderDate" || /注文日|order placed/i.test(text));
    });
    const date = orderDateFromTexts(dateNodes.map(textContent));
    if (date !== undefined) dates.push(date);
    const totals: number[] = [];
    const charged: number[] = [];
    for (const row of descendants(document).filter((node) => hasClass(node, "od-line-item-row"))) {
      const labelNode = descendants(row).find((node) => hasClass(node, "od-line-item-row-label"));
      const contentNode = descendants(row).find((node) =>
        hasClass(node, "od-line-item-row-content")
      );
      const label = normalizeText(textContent(labelNode ?? row));
      const amount = parseCurrencyAmount(textContent(contentNode ?? row));
      if (amount === undefined) continue;
      if (/ご請求額|請求額|amount charged|grand total/i.test(label)) charged.push(amount);
      if (/(?:この)?注文(?:の)?合計|order total/i.test(label)) totals.push(amount);
    }
    const result = reconcileDetailAmount(charged, totals);
    if (result.found && result.amount === undefined) ambiguousAmount = true;
    if (result.amount !== undefined) amounts.push(result.amount);
  }
  const uniqueAmounts = [...new Set(amounts)];
  return {
    amount: !ambiguousAmount && uniqueAmounts.length === 1 ? uniqueAmounts[0] : undefined,
    occurredAt: dates[0],
  };
}

export function parseOrderDetailAmount(payload: string): number | undefined {
  return parseOrderDetail(payload).amount;
}

function reconcileDetailAmount(
  charged: number[],
  totals: number[],
): { found: boolean; amount?: number } {
  if (charged.length === 0 && totals.length === 0) return { found: false };
  const uniqueTotals = [...new Set(totals)];
  if (charged.length === 0) {
    return uniqueTotals.length === 1 ? { found: true, amount: uniqueTotals[0] } : { found: true };
  }
  if (charged.length === 1) return { found: true, amount: charged[0] };
  if (uniqueTotals.length !== 1) return { found: true };

  const total = uniqueTotals[0]!;
  const chargedSum = charged.reduce((sum, amount) => sum + amount, 0);
  if (Number.isSafeInteger(chargedSum) && chargedSum === total) {
    return { found: true, amount: total };
  }
  if (charged.every((amount) => amount === total)) {
    return { found: true, amount: total };
  }
  return { found: true };
}

export function isEmptyOrderPage(payload: string): boolean {
  for (const html of htmlDocuments(payload)) {
    const document = parse(html) as unknown as HtmlNode;
    const text = normalizeText(textContent(document));
    if (
      /(?:ご)?注文(?:履歴)?(?:が見つかりません|はありません|がありません)|no orders(?: found)?/i
        .test(text)
    ) return true;
  }
  return false;
}

export function orderToCashOut(order: AmazonOrder, wallet: Wallet): CashOut {
  const metadata: Record<string, string> = {
    source: "amazon",
    order_id: order.id,
  };
  if (order.itemTitles.length > 0) metadata.items = order.itemTitles.join(" | ");
  if (order.status !== "") metadata.status = order.status;
  return {
    id: scopedID(wallet.connectionID, "transaction", order.id),
    connectionID: wallet.connectionID,
    amount: order.amount,
    occurredAt: order.occurredAt,
    from: wallet,
    to: { name: "Amazon.co.jp", metadata },
  };
}

function parseOrderCard(card: HtmlNode): AmazonOrder | undefined {
  const cardText = normalizeText(textContent(card));
  const id = orderID(card, cardText);
  if (id === "") return undefined;
  const occurredAt = orderDate(card, cardText);
  const amount = orderTotal(card);
  if (occurredAt === undefined || amount === undefined) return undefined;
  const status = statusText(card);
  const canceled = /キャンセル|cancelled|canceled/i.test(`${status} ${cardText}`);
  return {
    id,
    occurredAt,
    amount,
    itemTitles: itemTitles(card),
    status,
    canceled,
  };
}

function parseOrderReference(card: HtmlNode): AmazonOrderReference | undefined {
  if (!hasClass(card, "past-purchase-tile")) return undefined;
  const link = descendants(card).find((node) => hasClass(node, "item-card__link"));
  if (link === undefined) return undefined;
  const href = attribute(link, "href");
  const id = orderIDFromHref(href);
  if (id === "") return undefined;
  const occurredAt = orderDateFromTexts([attribute(link, "aria-label"), textContent(card)]);
  const titleNode = descendants(card).find((node) => hasClass(node, "item-card__primary-text")) ??
    descendants(card).find((node) =>
      hasClass(node, "past-purchase-tile__asin-information-primary-text-container")
    );
  const title = normalizeText(textContent(titleNode ?? card));
  const statusNode = descendants(card).find((node) =>
    hasClass(node, "past-purchase-tile__asin-information-secondary-text-container")
  );
  const status = normalizeText(textContent(statusNode ?? card));
  const reference: AmazonOrderReference = {
    id,
    itemTitles: title === "" ? [] : [title],
    status,
    canceled: /キャンセル|cancelled|canceled/i.test(status),
    detailPath: detailPath(id),
  };
  if (occurredAt !== undefined) reference.occurredAt = occurredAt;
  return reference;
}

function orderIDFromHref(href: string): string {
  try {
    const url = new URL(href, "https://www.amazon.co.jp");
    for (const name of ["orderID", "orderId", "oid"]) {
      const value = url.searchParams.get(name) ?? "";
      const match = value.match(ORDER_ID_PATTERN)?.[0];
      if (match !== undefined) return match;
    }
  } catch {
    // Invalid links are not order references.
  }
  return href.match(ORDER_ID_PATTERN)?.[0] ?? "";
}

function detailPath(id: string): string {
  const query = id.toUpperCase().startsWith("D")
    ? new URLSearchParams({ orderID: id })
    : new URLSearchParams({ ac: "od", oid: id });
  return id.toUpperCase().startsWith("D") ? `/gp/css/order-details?${query}` : `/gp/aw/ya?${query}`;
}

function orderID(card: HtmlNode, cardText: string): string {
  const attributeID = descendants(card).map((node) => attribute(node, "data-order-id"))
    .find((value) => ORDER_ID_PATTERN.test(value));
  if (attributeID !== undefined) return attributeID.match(ORDER_ID_PATTERN)?.[0] ?? "";
  const container = descendants(card).find((node) =>
    attribute(node, "data-component") === "orderId" || hasClass(node, "yohtmlc-order-id")
  );
  return (container === undefined ? cardText : textContent(container)).match(ORDER_ID_PATTERN)
    ?.[0] ??
    "";
}

function orderDate(card: HtmlNode, cardText: string): Date | undefined {
  const candidates = descendants(card).filter((node) => {
    const text = normalizeText(textContent(node));
    return attribute(node, "data-component") === "orderDate" ||
      (hasClass(node, "order-header__header-list-item") && /注文日|order placed/i.test(text));
  }).map(textContent);
  candidates.push(cardText);
  return orderDateFromTexts(candidates);
}

function orderDateFromTexts(candidates: string[]): Date | undefined {
  for (const candidate of candidates) {
    const normalized = normalizeDigits(candidate);
    const match = normalized.match(
      /(20\d{2})\s*(?:年|[\/.\-])\s*(\d{1,2})\s*(?:月|[\/.\-])\s*(\d{1,2})\s*日?/,
    );
    if (match === null) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const result = new Date(Date.UTC(year, month - 1, day) - JST_OFFSET_MS);
    const shifted = new Date(result.getTime() + JST_OFFSET_MS);
    if (
      shifted.getUTCFullYear() === year && shifted.getUTCMonth() + 1 === month &&
      shifted.getUTCDate() === day
    ) return result;
  }
  return undefined;
}

function orderTotal(card: HtmlNode): number | undefined {
  const candidates = descendants(card).filter((node) => {
    const text = normalizeText(textContent(node));
    return attribute(node, "data-component") === "orderTotal" ||
      hasClass(node, "yohtmlc-order-total") ||
      (hasClass(node, "order-header__header-list-item") && /合計|total/i.test(text));
  }).map((node) => normalizeText(textContent(node)));
  for (const candidate of candidates) {
    const amount = parseCurrencyAmount(candidate.replace(/^.*?(?:合計|total)\s*[:：]?/i, ""));
    if (amount !== undefined) return amount;
  }
  return undefined;
}

function itemTitles(card: HtmlNode): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const node of descendants(card)) {
    if (
      attribute(node, "data-component") !== "itemTitle" &&
      !hasClass(node, "yohtmlc-product-title")
    ) continue;
    const title = normalizeText(textContent(node));
    if (title !== "" && !seen.has(title)) {
      seen.add(title);
      result.push(title);
    }
  }
  return result;
}

function statusText(card: HtmlNode): string {
  const node = descendants(card).find((candidate) =>
    hasClass(candidate, "delivery-box__primary-text") ||
    hasClass(candidate, "yohtmlc-shipment-status-primaryText") ||
    hasClass(candidate, "od-status-message")
  );
  return node === undefined ? "" : normalizeText(textContent(node));
}

function isOrderCard(node: HtmlNode): boolean {
  if (node.tagName !== "div") return false;
  const classes = classNames(node);
  if (
    classes.has("order-card") || classes.has("js-order-card") ||
    classes.has("past-purchase-tile")
  ) return true;
  if (!classes.has("order")) return false;
  return ORDER_ID_PATTERN.test(textContent(node));
}

function htmlDocuments(payload: string): string[] {
  const documents = [payload];
  const seen = new Set(documents);
  const addValue = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.includes("<") && !seen.has(value)) {
        seen.add(value);
        documents.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) addValue(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) addValue(item);
    }
  };
  try {
    addValue(JSON.parse(payload));
  } catch {
    for (const chunk of payload.split("&&&")) {
      const candidate = chunk.trim();
      if (candidate === "") continue;
      try {
        addValue(JSON.parse(candidate));
      } catch {
        // Continue with the looser AUI string extraction below.
      }
    }
    for (const line of payload.split(/\r?\n/)) {
      const candidate = line.trim().replace(/^&&&(?:START|END)&&&$/, "");
      if (candidate === "") continue;
      try {
        addValue(JSON.parse(candidate));
      } catch {
        // AUI can mix protocol markers and JSON chunks; string literals are handled below.
      }
    }
    for (const match of payload.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      try {
        addValue(JSON.parse(match[0]));
      } catch {
        // Ignore malformed protocol fragments.
      }
    }
  }
  return documents;
}

function descendants(root: HtmlNode): HtmlNode[] {
  const result: HtmlNode[] = [];
  const visit = (node: HtmlNode): void => {
    result.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return result;
}

function textContent(node: HtmlNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  if (node.tagName === "br") return " ";
  return (node.childNodes ?? []).map(textContent).join(" ");
}

function attribute(node: HtmlNode, name: string): string {
  return node.attrs?.find((item) => item.name === name)?.value ?? "";
}

function hasClass(node: HtmlNode, name: string): boolean {
  return classNames(node).has(name);
}

function classNames(node: HtmlNode): Set<string> {
  return new Set(attribute(node, "class").split(/\s+/).filter(Boolean));
}

function normalizeText(value: string): string {
  return value.replace(/\s/gu, " ").trim().split(/ +/).filter(Boolean).join(" ");
}

function normalizeDigits(value: string): string {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0xff10 && codePoint <= 0xff19) return String(codePoint - 0xff10);
    return character;
  }).join("");
}

function parseCurrencyAmount(value: string): number | undefined {
  const normalized = normalizeDigits(value);
  const match = normalized.match(/(?:￥|¥|JPY)?\s*([0-9][0-9,，]*)\s*(?:円)?/i);
  if (match === null) return undefined;
  const amount = Number(match[1]?.replaceAll(",", "").replaceAll("，", ""));
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined;
}
