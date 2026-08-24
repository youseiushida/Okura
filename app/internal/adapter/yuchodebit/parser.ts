import { createHash } from "node:crypto";
import { parse } from "parse5";
import type { Wallet } from "../../model/account.ts";
import { scopedID } from "../../model/connection.ts";
import type { CashOut } from "../../model/transaction.ts";
import type { TurnstileChallenge } from "../../port/turnstile_solver.ts";
import { CARD_COMPANY_CODE } from "./context.ts";
import { UnexpectedPageError } from "./errors.ts";
import {
  LOGIN_PATH,
  LOGIN_SUBMIT_PATH,
  LOGOUT_PATH,
  STATEMENT_DETAIL_PATH,
  STATEMENT_INDEX_PATH,
} from "./routes.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const PAGE_SIZE = 10;
const REQUIRED_HEADERS = [
  "お取引日",
  "お取引内容",
  "お取引通貨 金額",
  "お取引手数料",
  "ATM手数料",
  "為替手数料",
  "確定状態",
  "承認番号",
  "備考",
  "ご利用通貨 金額",
  "ご利用手数料",
  "換算レート",
] as const;

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

export interface FormField {
  readonly name: string;
  readonly value: string;
}

export interface ParsedSubmission {
  readonly action: string;
  readonly fields: readonly FormField[];
  readonly submitName: string;
}

export interface ParsedLoginPage {
  readonly challenge: TurnstileChallenge;
  readonly submission: ParsedSubmission;
}

export type YuchoDebitPageStatus = "authenticated" | "expired" | "unexpected";

export interface StatementMonth {
  readonly year: number;
  readonly month: number;
  readonly referenceDate: string;
  readonly submission: ParsedSubmission;
}

export interface ParsedStatementPage {
  readonly cashOuts: CashOut[];
  readonly resultCount: number;
  readonly currentPage: number;
  readonly totalPages: number;
  readonly next?: ParsedSubmission;
}

export function parseLoginPage(html: string, pageURL: string): ParsedLoginPage {
  const document = parseDocument(html);
  const form = descendants(document).find((node) =>
    node.tagName === "form" && input(node, "usrId") !== undefined &&
    input(node, "password") !== undefined
  );
  if (form === undefined) throw new UnexpectedPageError("login form was not found");
  const turnstile = descendants(form).find((node) =>
    node.tagName === "div" && hasClass(node, "cf-turnstile")
  );
  if (turnstile === undefined) throw new UnexpectedPageError("Turnstile widget was not found");
  const siteKey = requiredAttribute(turnstile, "data-sitekey", "Turnstile site key");
  const button = descendants(form).find((node) =>
    (node.tagName === "button" || node.tagName === "input") &&
    attribute(node, "name") !== "" && normalizeText(textContent(node)) === "ログイン"
  );
  if (button === undefined) throw new UnexpectedPageError("login submit control was not found");
  const submitName = attribute(button, "name");
  const action = submissionAction(document, submitName, pageURL);
  assertExpectedAction(action, pageURL, LOGIN_SUBMIT_PATH, "login");
  const fields = formFields(form);
  if (fieldValue(fields, "cc") !== CARD_COMPANY_CODE) {
    throw new UnexpectedPageError("login form has an unexpected card company code");
  }
  if (fieldValue(fields, "nablarch_hidden") === "") {
    throw new UnexpectedPageError("login form is missing Nablarch state");
  }
  return {
    challenge: {
      pageURL: new URL(pageURL).href,
      siteKey,
      ...optionalChallengeFields(turnstile),
    },
    submission: { action, fields, submitName },
  };
}

export function parsePageStatus(html: string): YuchoDebitPageStatus {
  const document = parseDocument(html);
  const links = descendants(document).filter((node) => node.tagName === "a");
  const hasStatementLink = links.some((node) =>
    safePath(attribute(node, "href")) ===
      STATEMENT_INDEX_PATH
  );
  const hasLogoutLink = links.some((node) => safePath(attribute(node, "href")) === LOGOUT_PATH);
  if (hasStatementLink && hasLogoutLink) return "authenticated";

  const hasCredentialForm = descendants(document).some((node) =>
    node.tagName === "form" && input(node, "usrId") !== undefined &&
    input(node, "password") !== undefined
  );
  const hasLoginLink = links.some((node) => safePath(attribute(node, "href")) === LOGIN_PATH);
  if (hasCredentialForm || (pageTitle(document) === "アクセスエラー" && hasLoginLink)) {
    return "expired";
  }
  return "unexpected";
}

export function hasPrimaryCredentialError(html: string): boolean {
  const text = normalizeText(textContent(parseDocument(html)));
  return /ユーザーID.*パスワード|パスワード.*ユーザーID/.test(text) &&
    /(正しく|誤り|一致|確認|入力)/.test(text);
}

export function hasTurnstileError(html: string): boolean {
  const text = normalizeText(textContent(parseDocument(html)));
  return /(ロボット|Turnstile|認証)/i.test(text) && /(失敗|確認|もう一度|エラー)/.test(text);
}

export function parseNavigationSubmission(
  html: string,
  pageURL: string,
  targetPath: string,
): ParsedSubmission {
  const document = parseDocument(html);
  const candidates = descendants(document).filter((node) =>
    node.tagName === "a" && attribute(node, "name") !== "" &&
    safePath(attribute(node, "href")) === targetPath
  );
  if (candidates.length < 1 || candidates.length > 2) {
    throw new UnexpectedPageError(
      `expected one or two navigation controls for ${
        JSON.stringify(targetPath)
      }, found ${candidates.length}`,
    );
  }
  const submissions = candidates.map((control) => {
    const form = closest(control, "form");
    if (form === undefined) throw new UnexpectedPageError("navigation control has no form");
    const action = new URL(attribute(control, "href"), pageURL).href;
    assertExpectedAction(action, pageURL, targetPath, "navigation");
    const fields = formFields(form);
    if (fieldValue(fields, "nablarch_hidden") === "") {
      throw new UnexpectedPageError("navigation form is missing Nablarch state");
    }
    return { action, fields, submitName: attribute(control, "name") };
  });
  return submissions[0]!;
}

export function parseStatementMonths(html: string, pageURL: string): StatementMonth[] {
  const document = parseDocument(html);
  const select = descendants(document).find((node) =>
    node.tagName === "select" && attribute(node, "name") === "W131301.referenceDate"
  );
  if (select === undefined) throw new UnexpectedPageError("statement month selector was not found");
  const form = closest(select, "form");
  if (form === undefined) throw new UnexpectedPageError("statement month selector has no form");
  const options = descendants(select).filter((node) => node.tagName === "option")
    .map((node) => ({
      referenceDate: attribute(node, "value"),
      label: normalizeText(textContent(node)),
    }))
    .filter((option) => option.referenceDate !== "");
  const controls = descendants(form).filter((node) =>
    node.tagName === "a" && /^nablarch_form\d+_\d+$/.test(attribute(node, "name")) &&
    safePath(attribute(node, "href")) === STATEMENT_DETAIL_PATH
  );
  if (options.length === 0 || controls.length !== options.length) {
    throw new UnexpectedPageError("statement month controls are incomplete");
  }
  const fields = formFields(form);
  if (fieldValue(fields, "nablarch_hidden") === "") {
    throw new UnexpectedPageError("statement month form is missing Nablarch state");
  }
  const seen = new Set<string>();
  return options.map((option, index) => {
    const match = option.label.match(/^(\d{4})年(\d{1,2})月(?:\(当月分\))?$/);
    if (match === null || !/^\d{8}$/.test(option.referenceDate)) {
      throw new UnexpectedPageError("statement month option is malformed");
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (
      month < 1 || month > 12 || option.referenceDate.slice(0, 6) !==
        `${year}${String(month).padStart(2, "0")}`
    ) {
      throw new UnexpectedPageError("statement month option is inconsistent");
    }
    const key = `${year}-${month}`;
    if (seen.has(key)) throw new UnexpectedPageError("statement month option is duplicated");
    seen.add(key);
    const control = controls[index]!;
    const action = new URL(attribute(control, "href"), pageURL).href;
    assertExpectedAction(action, pageURL, STATEMENT_DETAIL_PATH, "statement month");
    return {
      year,
      month,
      referenceDate: option.referenceDate,
      submission: {
        action,
        fields,
        submitName: attribute(control, "name"),
      },
    };
  });
}

export function parseStatementPage(
  html: string,
  pageURL: string,
  wallet: Wallet,
): ParsedStatementPage {
  const document = parseDocument(html);
  if (pageTitle(document) !== "利用明細照会") {
    throw new UnexpectedPageError("statement page title is missing");
  }
  const resultCount = consistentNumber(
    descendants(document).filter((node) => hasClass(node, "resultCountHeader")),
    /検索結果\s*(\d+)件/,
    "statement result count",
  );
  const page = consistentPair(
    descendants(document).filter((node) => hasClass(node, "nablarch_currentPageNumber")),
    /\[(\d+)\/(\d+)ページ\]/,
    "statement page number",
  );
  const [currentPage, totalPages] = page;
  if (
    resultCount < 0 || currentPage < 0 || totalPages < 0 ||
    (resultCount > 0 && (currentPage < 1 || totalPages < 1)) || currentPage > totalPages
  ) {
    throw new UnexpectedPageError("statement pagination is invalid");
  }
  const expectedTotalPages = resultCount === 0 ? totalPages : Math.ceil(resultCount / PAGE_SIZE);
  if (totalPages !== expectedTotalPages) {
    throw new UnexpectedPageError("statement result count disagrees with pagination");
  }

  const tables = descendants(document).filter((node) =>
    node.tagName === "table" && hasClass(node, "tableStyle3")
  );
  if (resultCount === 0) {
    if (tables.length !== 0) throw new UnexpectedPageError("empty statement contains a data table");
    return { cashOuts: [], resultCount, currentPage, totalPages };
  }
  if (tables.length !== 1) {
    throw new UnexpectedPageError(`expected one desktop statement table, found ${tables.length}`);
  }
  const rows = parseStatementRows(tables[0]!, wallet);
  const expectedRows = currentPage < totalPages
    ? PAGE_SIZE
    : resultCount - PAGE_SIZE * (currentPage - 1);
  if (rows.rowCount !== expectedRows) {
    throw new UnexpectedPageError(
      `statement page has ${rows.rowCount} rows, expected ${expectedRows}`,
    );
  }
  const next = parseNextSubmission(document, pageURL, currentPage < totalPages);
  return {
    cashOuts: rows.cashOuts,
    resultCount,
    currentPage,
    totalPages,
    ...(next === undefined ? {} : { next }),
  };
}

export function submissionBody(
  submission: ParsedSubmission,
  replacements: Readonly<Record<string, string>> = {},
): URLSearchParams {
  const result = new URLSearchParams();
  for (const field of submission.fields) {
    result.append(field.name, replacements[field.name] ?? field.value);
  }
  result.set("nablarch_submit", submission.submitName);
  for (const [name, value] of Object.entries(replacements)) {
    if (!submission.fields.some((field) => field.name === name)) result.set(name, value);
  }
  return result;
}

export function statementMonthStart(month: Pick<StatementMonth, "year" | "month">): Date {
  return jstDate(month.year, month.month, 1);
}

function parseStatementRows(
  table: HtmlNode,
  wallet: Wallet,
): { readonly cashOuts: CashOut[]; readonly rowCount: number } {
  const rows = tableRows(table);
  if (rows.length < 2) throw new UnexpectedPageError("statement table has no header rows");
  const headers = [
    ...directCells(rows[0]!, "th"),
    ...directCells(rows[1]!, "th"),
  ].map((cell) => normalizeText(textContent(cell)));
  if (
    headers.length !== REQUIRED_HEADERS.length ||
    !headers.every((header, index) => header === REQUIRED_HEADERS[index])
  ) {
    throw new UnexpectedPageError("statement table headers changed");
  }
  const dataRows = rows.slice(2);
  if (dataRows.length % 2 !== 0) {
    throw new UnexpectedPageError("statement table has an incomplete transaction row");
  }
  const result: CashOut[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < dataRows.length; index += 2) {
    const primary = directCells(dataRows[index]!, "td");
    const secondary = directCells(dataRows[index + 1]!, "td");
    if (primary.length !== 9 || secondary.length !== 4) {
      throw new UnexpectedPageError(`statement transaction ${index / 2 + 1} has changed shape`);
    }
    const cashOut = transactionRowsToCashOut(primary, secondary, wallet, index / 2 + 1);
    if (cashOut === undefined) continue;
    if (identities.has(cashOut.id)) {
      throw new UnexpectedPageError(
        `statement transaction ${index / 2 + 1} has a duplicate identity`,
      );
    }
    identities.add(cashOut.id);
    result.push(cashOut);
  }
  return { cashOuts: result, rowCount: dataRows.length / 2 };
}

function transactionRowsToCashOut(
  primary: HtmlNode[],
  secondary: HtmlNode[],
  wallet: Wallet,
  rowNumber: number,
): CashOut | undefined {
  const dateText = normalizeText(textContent(primary[0]!));
  const merchant = normalizeText(textContent(primary[1]!));
  const transactionAmount = parseCurrencyAmount(textContent(primary[2]!), rowNumber);
  const usageAmountText = normalizeText(textContent(secondary[0]!));
  const usageAmount = usageAmountText === "" ? undefined : parseCurrencyAmount(
    usageAmountText,
    rowNumber,
  );
  const occurredAt = parseJSTDate(dateText, rowNumber);
  if (merchant === "") throw new UnexpectedPageError(`statement row ${rowNumber} has no merchant`);
  const amount = normalizedJPYAmount(transactionAmount, usageAmount, rowNumber);
  if (amount < 0) return undefined;
  if (amount === 0) throw new UnexpectedPageError(`statement row ${rowNumber} has a zero amount`);

  const status = normalizeText(textContent(primary[6]!));
  const approvalNumber = normalizeText(textContent(primary[7]!));
  const note = normalizeText(textContent(primary[8]!));
  if (approvalNumber !== "" && !/^\d{6}$/.test(approvalNumber)) {
    throw new UnexpectedPageError(`statement row ${rowNumber} has an invalid approval number`);
  }
  const metadata: Record<string, string> = {
    source: "yucho-debit",
    original_currency: transactionAmount.currency,
    original_amount: decimalString(transactionAmount),
  };
  addMetadata(metadata, "approval_number", approvalNumber);
  addMetadata(metadata, "status", status);
  addMetadata(metadata, "note", note);
  addMetadata(metadata, "transaction_fee", normalizeText(textContent(primary[3]!)));
  addMetadata(metadata, "atm_fee", normalizeText(textContent(primary[4]!)));
  addMetadata(metadata, "exchange_fee", normalizeText(textContent(primary[5]!)));
  addMetadata(metadata, "usage_fee", normalizeText(textContent(secondary[1]!)));
  addMetadata(metadata, "exchange_rate", normalizeText(textContent(secondary[2]!)));

  const identity = createHash("sha256").update([
    dateText,
    merchant,
    transactionAmount.currency,
    decimalString(transactionAmount),
    approvalNumber,
    note,
  ].join("\0")).digest("hex");
  return {
    id: scopedID(wallet.connectionID, "transaction", identity),
    connectionID: wallet.connectionID,
    amount,
    occurredAt,
    from: wallet,
    to: { name: merchant, metadata },
  };
}

interface CurrencyAmount {
  readonly currency: string;
  readonly minorUnits: number;
}

function parseCurrencyAmount(value: string, rowNumber: number): CurrencyAmount {
  const normalized = normalizeDigits(normalizeText(value)).replace(/[−△▲]/g, "-");
  const match = normalized.match(/^([A-Z]{3})\s+([+-]?\d[\d,]*)(?:\.(\d{2}))?$/);
  if (match === null) {
    throw new UnexpectedPageError(`statement row ${rowNumber} has an invalid currency amount`);
  }
  const majorText = match[2]!.replaceAll(",", "");
  const sign = majorText.startsWith("-") ? -1 : 1;
  const major = Number(majorText.replace(/^[+-]/, ""));
  const fraction = Number(match[3] ?? "00");
  if (!Number.isSafeInteger(major) || !Number.isInteger(fraction)) {
    throw new UnexpectedPageError(`statement row ${rowNumber} amount is out of range`);
  }
  const minorUnits = sign * (major * 100 + fraction);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new UnexpectedPageError(`statement row ${rowNumber} amount is out of range`);
  }
  return { currency: match[1]!, minorUnits };
}

function normalizedJPYAmount(
  transaction: CurrencyAmount,
  usage: CurrencyAmount | undefined,
  rowNumber: number,
): number {
  if (
    usage !== undefined &&
    Math.sign(transaction.minorUnits) !== Math.sign(usage.minorUnits)
  ) {
    throw new UnexpectedPageError(`statement row ${rowNumber} has inconsistent amount signs`);
  }
  const selected = usage ?? transaction;
  if (selected.currency !== "JPY" || selected.minorUnits % 100 !== 0) {
    throw new UnexpectedPageError(`statement row ${rowNumber} has no integral JPY amount`);
  }
  if (
    usage !== undefined && transaction.currency === "JPY" &&
    transaction.minorUnits !== usage.minorUnits
  ) {
    throw new UnexpectedPageError(`statement row ${rowNumber} has ambiguous JPY amounts`);
  }
  return selected.minorUnits / 100;
}

function decimalString(value: CurrencyAmount): string {
  const sign = value.minorUnits < 0 ? "-" : "";
  const magnitude = Math.abs(value.minorUnits);
  return `${sign}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
}

function parseJSTDate(value: string, rowNumber: number): Date {
  const match = normalizeDigits(value).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (match === null) {
    throw new UnexpectedPageError(`statement row ${rowNumber} has an invalid date`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = jstDate(year, month, day);
  const shifted = new Date(result.getTime() + JST_OFFSET_MS);
  if (
    shifted.getUTCFullYear() !== year || shifted.getUTCMonth() + 1 !== month ||
    shifted.getUTCDate() !== day
  ) {
    throw new UnexpectedPageError(`statement row ${rowNumber} has an invalid date`);
  }
  return result;
}

function parseNextSubmission(
  document: HtmlNode,
  pageURL: string,
  required: boolean,
): ParsedSubmission | undefined {
  const controls = descendants(document).filter((node) =>
    node.tagName === "a" && attribute(node, "name") === "nextSubmit" &&
    safePath(attribute(node, "href")) === STATEMENT_DETAIL_PATH
  );
  if (!required) {
    if (controls.length !== 0) {
      throw new UnexpectedPageError("last statement page unexpectedly has a next control");
    }
    return undefined;
  }
  if (controls.length !== 1) {
    throw new UnexpectedPageError("statement next control is missing or duplicated");
  }
  const control = controls[0]!;
  const form = closest(control, "form");
  if (form === undefined) throw new UnexpectedPageError("statement next control has no form");
  const fields = formFields(form);
  if (fieldValue(fields, "nablarch_hidden") === "") {
    throw new UnexpectedPageError("statement pagination is missing Nablarch state");
  }
  const action = new URL(attribute(control, "href"), pageURL).href;
  assertExpectedAction(action, pageURL, STATEMENT_DETAIL_PATH, "statement pagination");
  return { action, fields, submitName: "nextSubmit" };
}

function consistentNumber(
  nodes: HtmlNode[],
  pattern: RegExp,
  name: string,
): number {
  const values = nodes.map((node) => pattern.exec(normalizeText(textContent(node)))?.[1])
    .filter((value): value is string => value !== undefined).map(Number);
  if (values.length === 0 || values.some((value) => value !== values[0])) {
    throw new UnexpectedPageError(`${name} is missing or inconsistent`);
  }
  return values[0]!;
}

function consistentPair(
  nodes: HtmlNode[],
  pattern: RegExp,
  name: string,
): readonly [number, number] {
  const values = nodes.map((node) => pattern.exec(normalizeText(textContent(node))))
    .filter((value): value is RegExpExecArray => value !== null)
    .map((match) => [Number(match[1]), Number(match[2])] as const);
  if (
    values.length === 0 ||
    values.some((value) => value[0] !== values[0]![0] || value[1] !== values[0]![1])
  ) {
    throw new UnexpectedPageError(`${name} is missing or inconsistent`);
  }
  return values[0]!;
}

function formFields(form: HtmlNode): FormField[] {
  const result: FormField[] = [];
  for (const control of descendants(form)) {
    if (hasAttribute(control, "disabled")) continue;
    const name = attribute(control, "name");
    if (name === "") continue;
    if (control.tagName === "input") {
      const type = attribute(control, "type").toLowerCase();
      if (["button", "file", "image", "reset", "submit"].includes(type)) continue;
      if ((type === "checkbox" || type === "radio") && !hasAttribute(control, "checked")) {
        continue;
      }
      result.push({ name, value: attribute(control, "value") });
    } else if (control.tagName === "textarea") {
      result.push({ name, value: textContent(control) });
    } else if (control.tagName === "select") {
      const options = descendants(control).filter((node) => node.tagName === "option");
      const selected = options.filter((node) => hasAttribute(node, "selected"));
      for (const option of selected.length === 0 ? options.slice(0, 1) : selected) {
        result.push({ name, value: attribute(option, "value") });
      }
    }
  }
  return result;
}

function optionalChallengeFields(node: HtmlNode): Pick<
  TurnstileChallenge,
  "action" | "cData" | "chlPageData"
> {
  const action = attribute(node, "data-action");
  const cData = attribute(node, "data-cdata");
  const chlPageData = attribute(node, "data-chl-page-data");
  return {
    ...(action === "" ? {} : { action }),
    ...(cData === "" ? {} : { cData }),
    ...(chlPageData === "" ? {} : { chlPageData }),
  };
}

function submissionAction(document: HtmlNode, submitName: string, pageURL: string): string {
  const escapedName = submitName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `"${escapedName}"\\s*:\\s*\\{[^{}]*"action"\\s*:\\s*"([^"]+)"`,
  );
  const actions = descendants(document).filter((node) => node.tagName === "script")
    .map((node) => pattern.exec(textContent(node))?.[1]).filter((value): value is string =>
      value !== undefined
    );
  if (actions.length !== 1) {
    throw new UnexpectedPageError("login action is missing or duplicated");
  }
  return new URL(actions[0]!, pageURL).href;
}

function assertExpectedAction(
  action: string,
  pageURL: string,
  expectedPath: string,
  operation: string,
): void {
  const result = new URL(action);
  const page = new URL(pageURL);
  if (
    result.origin !== page.origin || stripPathParameters(result.pathname) !== expectedPath ||
    result.search !== "" || result.hash !== ""
  ) {
    throw new UnexpectedPageError(`${operation} form has an unexpected action`);
  }
}

function stripPathParameters(path: string): string {
  return path.replace(/;[^/]*$/, "");
}

function tableRows(table: HtmlNode): HtmlNode[] {
  const result: HtmlNode[] = [];
  for (const child of table.childNodes ?? []) {
    if (child.tagName === "tr") result.push(child);
    if (child.tagName === "thead" || child.tagName === "tbody" || child.tagName === "tfoot") {
      result.push(...(child.childNodes ?? []).filter((node) => node.tagName === "tr"));
    }
  }
  return result;
}

function directCells(row: HtmlNode, tagName: "th" | "td"): HtmlNode[] {
  return (row.childNodes ?? []).filter((node) => node.tagName === tagName);
}

function fieldValue(fields: readonly FormField[], name: string): string {
  return fields.find((field) => field.name === name)?.value ?? "";
}

function input(root: HtmlNode, name: string): HtmlNode | undefined {
  return descendants(root).find((node) =>
    node.tagName === "input" && attribute(node, "name") === name
  );
}

function closest(node: HtmlNode, tagName: string): HtmlNode | undefined {
  let current: HtmlNode | undefined = node;
  while (current !== undefined) {
    if (current.tagName === tagName) return current;
    current = current.parentNode;
  }
  return undefined;
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

function parseDocument(html: string): HtmlNode {
  return parse(html) as unknown as HtmlNode;
}

function pageTitle(document: HtmlNode): string {
  const title = descendants(document).find((node) => node.tagName === "title");
  return title === undefined ? "" : normalizeText(textContent(title));
}

function textContent(node: HtmlNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  if (node.tagName === "br") return " ";
  return (node.childNodes ?? []).map(textContent).join(" ");
}

function requiredAttribute(node: HtmlNode, name: string, label: string): string {
  const value = attribute(node, name);
  if (value === "" || hasControlCharacter(value)) {
    throw new UnexpectedPageError(`${label} is invalid`);
  }
  return value;
}

function attribute(node: HtmlNode, name: string): string {
  return node.attrs?.find((item) => item.name === name)?.value ?? "";
}

function hasAttribute(node: HtmlNode, name: string): boolean {
  return node.attrs?.some((item) => item.name === name) ?? false;
}

function hasClass(node: HtmlNode, name: string): boolean {
  return attribute(node, "class").split(/\s+/).includes(name);
}

function safePath(value: string): string {
  if (value === "") return "";
  try {
    return stripPathParameters(new URL(value, "https://invalid.local").pathname);
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

function jstDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - JST_OFFSET_MS);
}

function addMetadata(metadata: Record<string, string>, key: string, value: string): void {
  if (value !== "") metadata[key] = value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
