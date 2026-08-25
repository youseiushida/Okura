import { createHash } from "node:crypto";
import { parse } from "parse5";
import type { CashIn, CashOut } from "../../model/transaction.ts";
import type { Wallet } from "../../model/account.ts";
import { scopedID } from "../../model/connection.ts";
import type { Period } from "../../port/source.ts";
import { PeriodUnavailableError, UnexpectedPageError } from "./errors.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const STATEMENT_CYCLE_COUNT = 15;
const SETTLED_HEADERS = [
  "ご利用者",
  "お振替日",
  "ご利用先など",
  "お振替金額",
  "摘要",
  "承認番号",
] as const;
const DIFFERENCE_HEADERS = [
  "ご利用者",
  "差額発生日",
  "ご利用先など",
  "差額",
  "摘要",
  "お取引結果",
  "承認番号",
] as const;
const COMPLETED_DIFFERENCE_STATUS = "銀行振替済";

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

export interface StatementRow {
  id: string;
  kind: "settled" | "difference";
  user: string;
  occurredAt: Date;
  merchant: string;
  amount: number;
  description: string;
  approvalNumber: string;
  status: string;
}

export type MypageStatus = "authenticated" | "expired" | "unexpected";

export function parseMypageStatus(html: string): MypageStatus {
  const document = parse(html) as unknown as HtmlNode;
  let hasLogoutLink = false;
  let hasDebitDetailMenuLink = false;
  let hasErrorWrapper = false;
  let hasCommunicationErrorHeading = false;
  let hasErrorHelpLink = false;

  visit(document, (node) => {
    const classes = new Set(attribute(node, "class").split(/\s+/).filter(Boolean));
    if (classes.has("wrapper") && classes.has("error")) hasErrorWrapper = true;
    if (
      node.tagName === "a" && attribute(node, "name") === "toHeaderUserLogout"
    ) {
      hasLogoutLink = true;
    }
    if (
      node.tagName === "a" && attribute(node, "name") === "toNaviDebitDetailMenu"
    ) {
      hasDebitDetailMenuLink = true;
    }
    if (
      /^h[1-3]$/.test(node.tagName ?? "") &&
      normalizeText(textContent(node)) === "通信エラーが発生しました"
    ) {
      hasCommunicationErrorHeading = true;
    }
    if (
      node.tagName === "a" &&
      attribute(node, "href").split(/[?#]/, 1)[0] === "/support/pop/myjcberror.html"
    ) {
      hasErrorHelpLink = true;
    }
  });

  if (hasLogoutLink && hasDebitDetailMenuLink) return "authenticated";
  if (hasErrorWrapper && hasCommunicationErrorHeading && hasErrorHelpLink) return "expired";
  return "unexpected";
}

export function statementRowToCashOut(row: StatementRow, wallet: Wallet): CashOut {
  if (row.amount <= 0) throw new TypeError("jcb: cash-out amount must be positive");
  return {
    id: scopedID(wallet.connectionID, "transaction", row.id),
    connectionID: wallet.connectionID,
    amount: row.amount,
    occurredAt: row.occurredAt,
    from: wallet,
    to: { name: row.merchant, metadata: statementMetadata(row) },
  };
}

export function statementRowToCashIn(row: StatementRow, wallet: Wallet): CashIn {
  if (row.amount >= 0) throw new TypeError("jcb: cash-in amount must be negative on statement");
  return {
    id: scopedID(wallet.connectionID, "transaction", row.id),
    connectionID: wallet.connectionID,
    amount: -row.amount,
    occurredAt: row.occurredAt,
    from: { name: row.merchant, metadata: statementMetadata(row) },
    to: wallet,
  };
}

export function parseStatement(html: string): { rows: StatementRow[]; found: boolean } {
  const document = parse(html) as unknown as HtmlNode;
  let foundSettled = false;
  let foundDifference = false;
  const rows: StatementRow[] = [];

  for (const table of findTargetTables(document)) {
    const parsed = parseTable(table);
    if (sameHeaders(parsed.headers, SETTLED_HEADERS)) {
      if (foundSettled) throw new UnexpectedPageError("duplicate settled statement table");
      foundSettled = true;
      rows.push(...buildStatementRows(parsed.headers, parsed.rows, {
        kind: "settled",
        dateHeader: "お振替日",
        amountHeader: "お振替金額",
      }));
      continue;
    }
    if (sameHeaders(parsed.headers, DIFFERENCE_HEADERS)) {
      if (foundDifference) throw new UnexpectedPageError("duplicate difference statement table");
      foundDifference = true;
      rows.push(...buildStatementRows(parsed.headers, parsed.rows, {
        kind: "difference",
        dateHeader: "差額発生日",
        amountHeader: "差額",
        statusHeader: "お取引結果",
      }));
      continue;
    }
    throw new UnexpectedPageError("unrecognized statement table headers");
  }

  return { rows, found: foundSettled };
}

export function statementSequences(period: Period, now: Date): number[] {
  assertValidDate(period.from, "period start");
  assertValidDate(period.to, "period end");
  if (period.from.getTime() > period.to.getTime()) {
    throw new TypeError("jcb: period start must not be after its end");
  }
  if (period.from.getTime() === period.to.getTime()) return [];

  const newestStart = cycleStart(now);
  const oldestStart = addJSTMonths(newestStart, -(STATEMENT_CYCLE_COUNT - 1));
  if (period.from.getTime() < oldestStart.getTime()) throw new PeriodUnavailableError(oldestStart);

  const sequences: number[] = [];
  for (let sequence = 0; sequence < STATEMENT_CYCLE_COUNT; sequence += 1) {
    const start = addJSTMonths(newestStart, -sequence);
    const end = addJSTMonths(start, 1);
    if (start.getTime() < period.to.getTime() && period.from.getTime() < end.getTime()) {
      sequences.push(sequence);
    }
  }
  return sequences;
}

export function cycleStart(at: Date): Date {
  assertValidDate(at, "current time");
  const local = jstParts(at);
  let year = local.year;
  let month = local.month;
  if (local.day < 16) {
    month -= 1;
    if (month === 0) {
      year -= 1;
      month = 12;
    }
  }
  return jstDate(year, month, 16);
}

interface StatementRowConfig {
  readonly kind: StatementRow["kind"];
  readonly dateHeader: string;
  readonly amountHeader: string;
  readonly statusHeader?: string;
}

function buildStatementRows(
  headers: string[],
  rawRows: string[][],
  config: StatementRowConfig,
): StatementRow[] {
  const columns = new Map(headers.map((header, index) => [header, index]));
  const result: StatementRow[] = [];
  const occurrences = new Map<string, number>();
  for (const [rowIndex, cells] of rawRows.entries()) {
    if (cells.length < headers.length) {
      throw new UnexpectedPageError(
        `row ${rowIndex + 1} has ${cells.length} cells, want at least ${headers.length}`,
      );
    }
    try {
      const occurredAt = parseDate(cell(cells, columns, config.dateHeader));
      const amount = parseAmount(cell(cells, columns, config.amountHeader));
      if (amount === 0) throw new TypeError("amount must not be zero");
      const user = cell(cells, columns, "ご利用者");
      const merchant = cell(cells, columns, "ご利用先など");
      const description = cell(cells, columns, "摘要");
      const approvalNumber = cell(cells, columns, "承認番号");
      const status = config.statusHeader === undefined
        ? ""
        : cell(cells, columns, config.statusHeader);
      const identityParts = [
        formatJSTDate(occurredAt),
        user,
        merchant,
        String(amount),
        description,
        approvalNumber,
      ];
      if (config.kind === "difference") {
        identityParts.unshift(config.kind);
      }
      const fingerprint = identityParts.join("\0");
      const ordinal = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, ordinal + 1);
      result.push({
        id: transactionID(fingerprint, ordinal),
        kind: config.kind,
        user,
        occurredAt,
        merchant,
        amount,
        description,
        approvalNumber,
        status,
      });
    } catch (error) {
      if (error instanceof UnexpectedPageError) throw error;
      throw new UnexpectedPageError(`row ${rowIndex + 1}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
  return result;
}

function parseDate(value: string): Date {
  const normalized = normalizeDigits(value);
  const match = normalized.match(/^(\d{4})(?:\/|年)(\d{1,2})(?:\/|月)(\d{1,2})(?:日)?$/);
  if (match === null) throw new TypeError("unsupported date format");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = jstDate(year, month, day);
  const parts = jstParts(result);
  if (parts.year !== year || parts.month !== month || parts.day !== day) {
    throw new TypeError("unsupported date format");
  }
  return result;
}

function parseAmount(value: string): number {
  const normalized = normalizeDigits(value)
    .replaceAll(",", "")
    .replaceAll("，", "")
    .replaceAll("円", "")
    .replaceAll(" ", "");
  if (normalized === "") throw new TypeError("amount is empty");
  if (!/^-?\d+$/.test(normalized)) throw new TypeError("unsupported amount format");
  const amount = Number(normalized);
  if (!Number.isSafeInteger(amount)) throw new TypeError("amount exceeds the safe integer range");
  return amount;
}

function normalizeDigits(value: string): string {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0xff10 && codePoint <= 0xff19) return String(codePoint - 0xff10);
    if (character === "／") return "/";
    if (character === "－" || character === "−") return "-";
    return character;
  }).join("");
}

function transactionID(fingerprint: string, ordinal: number): string {
  return createHash("sha256").update(`${fingerprint}\0${ordinal}`).digest("hex");
}

function findTargetTables(node: HtmlNode): HtmlNode[] {
  const result: HtmlNode[] = [];
  if (node.tagName === "table") {
    const classes = new Set(attribute(node, "class").split(/\s+/).filter(Boolean));
    if (classes.has("usage_detail-table01") && classes.has("table_detail02")) {
      result.push(node);
    }
  }
  for (const child of node.childNodes ?? []) {
    result.push(...findTargetTables(child));
  }
  return result;
}

function parseTable(table: HtmlNode): { headers: string[]; rows: string[][] } {
  const head = directChild(table, "thead");
  const body = directChild(table, "tbody");
  const headerRow = head === undefined ? undefined : directChildren(head, "tr")[0];
  const headers = headerRow === undefined
    ? []
    : directChildren(headerRow, "th").map((cell) => normalizeText(textContent(cell)));
  const rows = body === undefined
    ? []
    : directChildren(body, "tr").map((row) =>
      directChildren(row, "td").map((cell) => normalizeText(textContent(cell)))
    ).filter((row) => row.length > 0);
  return { headers, rows };
}

function sameHeaders(
  actual: string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length &&
    actual.every((header, index) => header === expected[index]);
}

function visit(node: HtmlNode, callback: (node: HtmlNode) => void): void {
  callback(node);
  for (const child of node.childNodes ?? []) visit(child, callback);
}

function directChild(node: HtmlNode, tagName: string): HtmlNode | undefined {
  return directChildren(node, tagName)[0];
}

function directChildren(node: HtmlNode, tagName: string): HtmlNode[] {
  return (node.childNodes ?? []).filter((child) => child.tagName === tagName);
}

function textContent(node: HtmlNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  if (node.tagName === "br") return " ";
  return (node.childNodes ?? []).map(textContent).join("");
}

function attribute(node: HtmlNode, name: string): string {
  return node.attrs?.find((item) => item.name === name)?.value ?? "";
}

function normalizeText(value: string): string {
  return value.replace(/\s/gu, " ").trim().split(/ +/).filter(Boolean).join(" ");
}

function cell(cells: string[], columns: Map<string, number>, header: string): string {
  const index = columns.get(header);
  if (index === undefined || cells[index] === undefined) {
    throw new UnexpectedPageError(`missing ${header} cell`);
  }
  return cells[index];
}

function addMetadata(metadata: Record<string, string>, key: string, value: string): void {
  if (value !== "") metadata[key] = value;
}

function statementMetadata(row: StatementRow): Record<string, string> {
  const metadata: Record<string, string> = { source: "jcb" };
  addMetadata(metadata, "user", row.user);
  addMetadata(metadata, "description", row.description);
  addMetadata(metadata, "approval_number", row.approvalNumber);
  if (row.kind === "difference") {
    metadata.statement_section = "difference";
    addMetadata(metadata, "status", row.status);
  }
  return metadata;
}

export function isCompletedStatementRow(row: StatementRow): boolean {
  return row.kind === "settled" || row.status === COMPLETED_DIFFERENCE_STATUS;
}

function addJSTMonths(value: Date, months: number): Date {
  const parts = jstParts(value);
  return jstDate(parts.year, parts.month + months, parts.day);
}

function jstDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - JST_OFFSET_MS);
}

function jstParts(value: Date): { year: number; month: number; day: number } {
  const shifted = new Date(value.getTime() + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function formatJSTDate(value: Date): string {
  const parts = jstParts(value);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${
    String(parts.day).padStart(2, "0")
  }`;
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`jcb: ${label} is required`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
