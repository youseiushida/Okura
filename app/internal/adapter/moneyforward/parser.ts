import { parse } from "parse5";
import type { Wallet, WalletID } from "../../model/account.ts";
import type { AssetBalance, AssetID } from "../../model/asset.ts";
import { type ConnectionID, type ProviderConnection, scopedID } from "../../model/connection.ts";
import type { CashIn, CashOut, ExternalParty, Transfer } from "../../model/transaction.ts";
import { ParseError } from "./errors.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

interface HtmlAttribute {
  readonly name: string;
  readonly value: string;
}

interface HtmlNode {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly attrs?: readonly HtmlAttribute[];
  readonly childNodes?: readonly HtmlNode[];
  readonly parentNode?: HtmlNode;
}

export interface ParsedCashFlow {
  readonly id: string;
  readonly connectionID: ConnectionID;
  readonly tableName: string;
  readonly kind: "income" | "expense";
  readonly amount: number;
  readonly occurredAt: Date;
  readonly content: string;
  readonly wallet: Wallet;
  readonly largeCategory: string;
  readonly middleCategory: string;
  readonly memo: string;
  readonly target: boolean;
}

export interface ParsedTransfer extends Transfer {
  readonly kind: "transfer";
  readonly tableName: string;
}

export type ParsedMoneyForwardTransaction = ParsedCashFlow | ParsedTransfer;

export function parseAssetBalances(
  html: string,
  observedAt: Date,
  connection: ProviderConnection<"moneyforward">,
): AssetBalance[] {
  assertValidDate(observedAt, "wallet balance observation time");
  const document = parse(html) as unknown as HtmlNode;
  const tables = descendants(document).filter((node) =>
    node.tagName === "table" && hasClass(node, "table-depo")
  );
  if (tables.length === 0) throw new ParseError("Money Forward portfolio table was not found");

  const result: AssetBalance[] = [];
  const ids = new Set<string>();
  for (const table of tables) {
    for (const row of descendants(table).filter((node) => node.tagName === "tr")) {
      const cells = directCells(row);
      if (cells.length === 0 || cells[0]?.tagName !== "td") continue;
      if (cells.length < 2) throw new ParseError("Money Forward portfolio row is incomplete");
      const name = normalizeText(textContent(cells[0]!));
      const amount = parseAmount(textContent(cells[1]!), true);
      if (name === "" || amount === undefined) {
        throw new ParseError("Money Forward portfolio row has an invalid name or amount");
      }
      const institution = normalizeText(textContent(cells[2] ?? emptyNode()));
      const id = assetIDFromName(name, institution, connection.id);
      if (ids.has(id)) {
        throw new ParseError(`Money Forward portfolio contains duplicate asset ${id}`);
      }
      ids.add(id);
      result.push({
        asset: {
          id,
          connectionID: connection.id,
          name,
          metadata: {
            source: "moneyforward",
            kind: "portfolio",
            ...(institution === "" ? {} : { institution }),
          },
        },
        amount,
        observedAt: new Date(observedAt),
      });
    }
  }
  return result;
}

export function extractCashFlowHTML(javascript: string): string {
  const candidates = javascriptStrings(javascript)
    .filter((value) => /<form\b[^>]*\/cf\/update|\btransaction_list\b/i.test(value))
    .sort((left, right) => right.length - left.length);
  const html = candidates[0];
  if (html === undefined) {
    throw new ParseError("Money Forward cash-flow response did not contain transaction HTML");
  }
  return html;
}

export function parseCashFlows(
  html: string,
  month: Date,
  connection: ProviderConnection<"moneyforward">,
): ParsedCashFlow[] {
  return parseMoneyForwardTransactions(html, month, connection).filter(isParsedCashFlow);
}

export function parseTransfers(
  html: string,
  month: Date,
  connection: ProviderConnection<"moneyforward">,
): ParsedTransfer[] {
  return parseMoneyForwardTransactions(html, month, connection).filter(isParsedTransfer);
}

export function parseMoneyForwardTransactions(
  html: string,
  month: Date,
  connection: ProviderConnection<"moneyforward">,
): ParsedMoneyForwardTransaction[] {
  assertValidDate(month, "cash-flow month");
  const document = parse(`<table><tbody>${html}</tbody></table>`) as unknown as HtmlNode;
  const forms = descendants(document).filter((node) =>
    node.tagName === "form" && safePath(attribute(node, "action")) === "/cf/update"
  );
  const result = new Map<string, ParsedMoneyForwardTransaction>();
  for (const form of forms) {
    const row = closest(form, "tr");
    if (row === undefined) throw new ParseError("Money Forward transaction form has no table row");
    const rawID = inputValue(form, "user_asset_act[id]");
    const tableName = inputValue(form, "user_asset_act[table_name]");
    const isIncome = inputValue(form, "user_asset_act[is_income]");
    if (rawID === "" || tableName === "" || (isIncome !== "0" && isIncome !== "1")) {
      throw new ParseError("Money Forward transaction identity is incomplete");
    }

    const dateCell = findByClass(row, "date");
    const amountCell = findByClass(row, "amount");
    const contentCell = findByClass(row, "content");
    const walletCell = findByClass(row, "note");
    const transferBox = findByClass(row, "transfer_account_box");
    if (
      dateCell === undefined || amountCell === undefined || contentCell === undefined ||
      (walletCell === undefined && transferBox === undefined)
    ) {
      throw new ParseError(`Money Forward transaction ${rawID} is missing a required column`);
    }
    const amount = parseAmount(textContent(amountCell), false);
    const occurredAt = parseTransactionDate(dateCell, month);
    const content = normalizeText(textContent(contentCell));
    if (amount === undefined || content === "") {
      throw new ParseError(`Money Forward transaction ${rawID} has invalid values`);
    }
    const id = scopedID(connection.id, "transaction", `${tableName}:${rawID}`);
    if (result.has(id)) continue;

    if (walletCell === undefined && transferBox !== undefined) {
      if (findByClass(row, "transfer_account_box_02") !== undefined) continue;
      const transferCell = closest(transferBox, "td");
      if (transferCell === undefined) {
        throw new ParseError(`Money Forward transfer ${rawID} has no account column`);
      }
      if (transferBox.parentNode !== transferCell) continue;
      const fromName = normalizeText(textContentExcluding(transferCell, transferBox));
      const toName = normalizeText(textContent(transferBox));
      // The page can temporarily contain a half-configured transfer. It must not be counted as
      // ordinary income/expense, but it cannot be represented as a Transfer until both ends exist.
      if (fromName === "" || toName === "") continue;
      result.set(id, {
        id,
        connectionID: connection.id,
        tableName,
        kind: "transfer",
        amount: Math.abs(amount),
        occurredAt,
        from: walletFromName(fromName, connection.id),
        to: walletFromName(toName, connection.id),
      });
      continue;
    }

    const walletName = normalizeText(textContent(walletCell!));
    if (walletName === "") {
      throw new ParseError(`Money Forward transaction ${rawID} has invalid values`);
    }
    result.set(id, {
      id,
      connectionID: connection.id,
      tableName,
      kind: isIncome === "1" ? "income" : "expense",
      amount: Math.abs(amount),
      occurredAt,
      content,
      wallet: walletFromName(
        walletName,
        connection.id,
        inputValue(form, "user_asset_act[sub_account_id_hash]"),
      ),
      largeCategory: normalizeText(textContent(findByClass(row, "lctg") ?? emptyNode())),
      middleCategory: normalizeText(textContent(findByClass(row, "mctg") ?? emptyNode())),
      memo: inputValue(form, "user_asset_act[memo]").trim(),
      target: inputValue(form, "user_asset_act[is_target]") !== "0",
    });
  }
  return [...result.values()];
}

export function parsedTransferToTransfer(value: ParsedTransfer): Transfer {
  return {
    id: value.id,
    connectionID: value.connectionID,
    amount: value.amount,
    occurredAt: new Date(value.occurredAt),
    from: value.from,
    to: value.to,
  };
}

export function cashFlowToCashIn(value: ParsedCashFlow): CashIn {
  if (value.kind !== "income") throw new TypeError("cash flow is not income");
  return {
    id: value.id,
    connectionID: value.connectionID,
    amount: value.amount,
    occurredAt: new Date(value.occurredAt),
    from: externalParty(value),
    to: value.wallet,
  };
}

export function cashFlowToCashOut(value: ParsedCashFlow): CashOut {
  if (value.kind !== "expense") throw new TypeError("cash flow is not an expense");
  return {
    id: value.id,
    connectionID: value.connectionID,
    amount: value.amount,
    occurredAt: new Date(value.occurredAt),
    from: value.wallet,
    to: externalParty(value),
  };
}

export function walletIDFromName(name: string, connectionID: ConnectionID): WalletID {
  return scopedID(connectionID, "wallet", encodedName(name, "wallet"));
}

export function assetIDFromName(
  name: string,
  institution: string,
  connectionID: ConnectionID,
): AssetID {
  const normalizedName = normalizeText(name);
  const normalizedInstitution = normalizeText(institution);
  const identity = normalizedInstitution === ""
    ? normalizedName
    : `${normalizedInstitution}\u0000${normalizedName}`;
  return scopedID(connectionID, "asset", encodedName(identity, "asset"));
}

function encodedName(name: string, kind: string): string {
  const normalized = normalizeText(name);
  if (normalized === "") throw new TypeError(`moneyforward: ${kind} name is required`);
  const hex = [...new TextEncoder().encode(normalized)]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  return hex;
}

function externalParty(value: ParsedCashFlow): ExternalParty {
  return {
    name: value.content,
    metadata: {
      source: "moneyforward",
      table_name: value.tableName,
      target: String(value.target),
      ...(value.largeCategory === "" ? {} : { large_category: value.largeCategory }),
      ...(value.middleCategory === "" ? {} : { middle_category: value.middleCategory }),
      ...(value.memo === "" ? {} : { memo: value.memo }),
    },
  };
}

function isParsedCashFlow(value: ParsedMoneyForwardTransaction): value is ParsedCashFlow {
  return value.kind === "income" || value.kind === "expense";
}

function isParsedTransfer(value: ParsedMoneyForwardTransaction): value is ParsedTransfer {
  return value.kind === "transfer";
}

function walletFromName(
  name: string,
  connectionID: ConnectionID,
  accountHash = "",
): Wallet {
  return {
    id: walletIDFromName(name, connectionID),
    connectionID,
    name,
    metadata: {
      source: "moneyforward",
      ...(accountHash === "" ? {} : { account_hash: accountHash }),
    },
  };
}

function parseTransactionDate(cell: HtmlNode, month: Date): Date {
  const sortable = attribute(cell, "data-table-sortable-value");
  if (sortable !== "") {
    const timestamp = Date.parse(sortable);
    if (!Number.isNaN(timestamp)) return new Date(timestamp);
  }
  const match = normalizeDigits(textContent(cell)).match(/(\d{1,2})\s*[\/-]\s*(\d{1,2})/);
  if (match === null) throw new ParseError("Money Forward transaction date is invalid");
  const shifted = new Date(month.getTime() + JST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const candidate = new Date(
    Date.UTC(year, Number(match[1]) - 1, Number(match[2])) - JST_OFFSET_MS,
  );
  const check = new Date(candidate.getTime() + JST_OFFSET_MS);
  if (
    check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== Number(match[1]) ||
    check.getUTCDate() !== Number(match[2])
  ) throw new ParseError("Money Forward transaction date is invalid");
  return candidate;
}

function parseAmount(value: string, allowNegative: boolean): number | undefined {
  const normalized = normalizeDigits(value).replace(/[−△▲]/g, "-");
  const match = normalized.match(/[-+]?\s*[¥￥]?\s*([0-9][0-9,，]*)/);
  if (match === null) return undefined;
  const magnitude = Number(match[1]?.replaceAll(",", "").replaceAll("，", ""));
  if (!Number.isSafeInteger(magnitude)) return undefined;
  const negative = /^\s*-/.test(normalized);
  return negative && allowNegative ? -magnitude : magnitude;
}

function javascriptStrings(source: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const quote = source[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let raw = "";
    for (index += 1; index < source.length; index += 1) {
      const character = source[index]!;
      if (character === "\\") {
        raw += character + (source[++index] ?? "");
        continue;
      }
      if (character === quote) break;
      raw += character;
    }
    result.push(unescapeJavaScriptString(raw));
  }
  return result;
}

function unescapeJavaScriptString(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined) break;
    const simple: Record<string, string> = {
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "0": "\0",
    };
    if (simple[escaped] !== undefined) {
      result += simple[escaped];
      continue;
    }
    if (escaped === "\n") continue;
    if (escaped === "\r") {
      if (value[index + 1] === "\n") index += 1;
      continue;
    }
    const width = escaped === "x" ? 2 : escaped === "u" ? 4 : 0;
    if (width > 0) {
      const digits = value.slice(index + 1, index + 1 + width);
      if (new RegExp(`^[0-9a-fA-F]{${width}}$`).test(digits)) {
        result += String.fromCodePoint(Number.parseInt(digits, 16));
        index += width;
        continue;
      }
    }
    result += escaped;
  }
  return result;
}

function inputValue(root: HtmlNode, name: string): string {
  const input = descendants(root).find((node) =>
    node.tagName === "input" && attribute(node, "name") === name
  );
  return input === undefined ? "" : attribute(input, "value");
}

function findByClass(root: HtmlNode, name: string): HtmlNode | undefined {
  return descendants(root).find((node) => hasClass(node, name));
}

function closest(node: HtmlNode, tagName: string): HtmlNode | undefined {
  let current: HtmlNode | undefined = node;
  while (current !== undefined) {
    if (current.tagName === tagName) return current;
    current = current.parentNode;
  }
  return undefined;
}

function directCells(row: HtmlNode): HtmlNode[] {
  return (row.childNodes ?? []).filter((node) => node.tagName === "th" || node.tagName === "td");
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

function textContentExcluding(node: HtmlNode, excluded: HtmlNode): string {
  if (node === excluded) return "";
  if (node.nodeName === "#text") return node.value ?? "";
  if (node.tagName === "br") return " ";
  return (node.childNodes ?? []).map((child) => textContentExcluding(child, excluded)).join(" ");
}

function attribute(node: HtmlNode, name: string): string {
  return node.attrs?.find((item) => item.name === name)?.value ?? "";
}

function hasClass(node: HtmlNode, name: string): boolean {
  return attribute(node, "class").split(/\s+/).includes(name);
}

function safePath(value: string): string {
  if (value === "") return "";
  try {
    return new URL(value, "https://moneyforward.com/").pathname;
  } catch {
    return "invalid";
  }
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

function emptyNode(): HtmlNode {
  return { nodeName: "#text", value: "" };
}

function assertValidDate(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`moneyforward: ${name} is required`);
  }
}
