import { createHash } from "node:crypto";
import { parse } from "parse5";
import type { CashOut } from "../../model/transaction.ts";
import type { WalletID } from "../../model/account.ts";
import type { Period } from "../../port/source.ts";
import { PeriodUnavailableError, UnexpectedPageError } from "./errors.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const STATEMENT_CYCLE_COUNT = 15;
const REQUIRED_HEADERS = [
  "ご利用者",
  "お振替日",
  "ご利用先など",
  "お振替金額",
  "摘要",
  "承認番号",
] as const;

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
  user: string;
  occurredAt: Date;
  merchant: string;
  amount: number;
  description: string;
  approvalNumber: string;
}

export function statementRowToCashOut(row: StatementRow, walletID: WalletID): CashOut {
  const metadata: Record<string, string> = { source: "jcb" };
  addMetadata(metadata, "user", row.user);
  addMetadata(metadata, "description", row.description);
  addMetadata(metadata, "approval_number", row.approvalNumber);
  return {
    id: row.id,
    amount: row.amount,
    occurredAt: row.occurredAt,
    from: walletID,
    to: { name: row.merchant, metadata },
  };
}

export function parseStatement(html: string): { rows: StatementRow[]; found: boolean } {
  const document = parse(html) as unknown as HtmlNode;
  const table = findTargetTable(document);
  if (table === undefined) return { rows: [], found: false };

  const head = directChild(table, "thead");
  const body = directChild(table, "tbody");
  const headerRow = head === undefined ? undefined : directChildren(head, "tr")[0];
  const headers = headerRow === undefined
    ? []
    : directChildren(headerRow, "th").map((cell) => normalizeText(textContent(cell)));
  const rawRows = body === undefined
    ? []
    : directChildren(body, "tr").map((row) =>
      directChildren(row, "td").map((cell) => normalizeText(textContent(cell)))
    ).filter((row) => row.length > 0);

  return { rows: buildStatementRows(headers, rawRows), found: true };
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

function buildStatementRows(headers: string[], rawRows: string[][]): StatementRow[] {
  const columns = new Map(headers.map((header, index) => [header, index]));
  for (const header of REQUIRED_HEADERS) {
    if (!columns.has(header)) {
      throw new UnexpectedPageError(`missing ${JSON.stringify(header)} column`);
    }
  }

  const result: StatementRow[] = [];
  const occurrences = new Map<string, number>();
  for (const [rowIndex, cells] of rawRows.entries()) {
    if (cells.length < headers.length) {
      throw new UnexpectedPageError(
        `row ${rowIndex + 1} has ${cells.length} cells, want at least ${headers.length}`,
      );
    }
    try {
      const occurredAt = parseDate(cell(cells, columns, "お振替日"));
      const amount = parseAmount(cell(cells, columns, "お振替金額"));
      if (amount < 0) continue;
      const user = cell(cells, columns, "ご利用者");
      const merchant = cell(cells, columns, "ご利用先など");
      const description = cell(cells, columns, "摘要");
      const approvalNumber = cell(cells, columns, "承認番号");
      const fingerprint = [
        formatJSTDate(occurredAt),
        user,
        merchant,
        String(amount),
        description,
        approvalNumber,
      ].join("\0");
      const ordinal = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, ordinal + 1);
      result.push({
        id: transactionID(fingerprint, ordinal),
        user,
        occurredAt,
        merchant,
        amount,
        description,
        approvalNumber,
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
    .replaceAll(" ", "")
    .replace(/[△▲]/g, "-");
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
  return `jcb:${createHash("sha256").update(`${fingerprint}\0${ordinal}`).digest("hex")}`;
}

function findTargetTable(node: HtmlNode): HtmlNode | undefined {
  if (node.tagName === "table") {
    const classes = new Set(attribute(node, "class").split(/\s+/).filter(Boolean));
    if (classes.has("usage_detail-table01") && classes.has("table_detail02")) return node;
  }
  for (const child of node.childNodes ?? []) {
    const result = findTargetTable(child);
    if (result !== undefined) return result;
  }
  return undefined;
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
