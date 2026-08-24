import { CARD_COMPANY_CODE } from "./context.ts";
import {
  HOME_PATH,
  LOGIN_PATH,
  LOGIN_SUBMIT_PATH,
  LOGOUT_PATH,
  STATEMENT_DETAIL_PATH,
  STATEMENT_INDEX_PATH,
} from "./routes.ts";

export interface TestServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface TestTransaction {
  readonly date: string;
  readonly merchant: string;
  readonly transactionAmount: string;
  readonly usageAmount?: string;
  readonly approvalNumber?: string;
  readonly status?: string;
  readonly note?: string;
}

export interface TestMonth {
  readonly year: number;
  readonly month: number;
  readonly referenceDate: string;
}

export function startTestServer(
  handler: (request: Request) => Response | Promise<Response>,
): TestServer {
  const controller = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: controller.signal,
    onListen() {},
  }, handler);
  const address = server.addr as Deno.NetAddr;
  return {
    url: `http://${address.hostname}:${address.port}`,
    async close() {
      controller.abort();
      await server.finished;
    },
  };
}

export function loginHTML(siteKey = "test-site-key"): string {
  return `<!doctype html><html><head><title>ログイン</title></head><body>
    <form name="nablarch_form1" method="post">
      <input name="usrId" type="text" value="">
      <input name="password" type="password" value="">
      <input name="cc" type="hidden" value="${CARD_COMPANY_CODE}">
      <input name="nablarch_hidden" type="hidden" value="login-state">
      <input name="nablarch_submit" type="hidden" value="">
      <div class="cf-turnstile" data-sitekey="${siteKey}"></div>
      <button type="button" name="nablarch_form1_1">ログイン</button>
      <script>
        nablarch_submission_info.nablarch_form1 = {
          "nablarch_form1_1": {
            "action": "${LOGIN_SUBMIT_PATH};jsessionid=TEST.WEB000K01",
            "allowDoubleSubmission": true,
            "submissionAction": "TRANSITION"
          }
        };
      </script>
    </form>
  </body></html>`;
}

export function authenticatedHomeHTML(hidden = "home-state"): string {
  return `<!doctype html><html><head><title>TOP</title></head><body>
    ${authenticatedNavigation(hidden)}
  </body></html>`;
}

export function expiredHTML(): string {
  return `<!doctype html><html><head><title>アクセスエラー</title></head><body>
    <a href="${LOGIN_PATH};jsessionid=EXPIRED.WEB000K01">ログイン</a>
  </body></html>`;
}

export function statementIndexHTML(months: readonly TestMonth[]): string {
  const options = months.map((month) =>
    `<option value="${month.referenceDate}">${month.year}年${month.month}月${
      month === months[0] ? "(当月分)" : ""
    }</option>`
  ).join("");
  const links = months.map((_, index) =>
    `<a name="nablarch_form4_${index + 1}" href="${STATEMENT_DETAIL_PATH}"></a>`
  ).join("");
  return `<!doctype html><html><head><title>利用明細照会</title></head><body>
    ${authenticatedNavigation()}
    <form name="nablarch_form4" method="post">
      <select name="W131301.referenceDate">
        <option value="">--お選びください--</option>${options}
      </select>
      ${links}
      <input name="nablarch_hidden" type="hidden" value="month-state">
      <input name="nablarch_submit" type="hidden" value="">
    </form>
  </body></html>`;
}

export function statementPageHTML(config: {
  readonly resultCount: number;
  readonly currentPage: number;
  readonly totalPages: number;
  readonly transactions?: readonly TestTransaction[];
}): string {
  const transactions = config.transactions ?? [];
  const table = transactions.length === 0 ? "" : `<table class="tableStyle3"><thead>
      <tr>
        <th rowspan="2">お取引日</th><th rowspan="2">お取引内容</th>
        <th>お取引通貨 金額</th><th>お取引手数料</th><th>ATM手数料</th>
        <th>為替手数料</th><th rowspan="2">確定状態</th>
        <th rowspan="2">承認番号</th><th rowspan="2">備考</th>
      </tr>
      <tr><th>ご利用通貨 金額</th><th>ご利用手数料</th><th>換算レート</th><td></td></tr>
    </thead><tbody>${transactions.map(transactionRows).join("")}</tbody></table>`;
  const previous = config.currentPage > 1
    ? `<a name="prevSubmit" class="nablarch_prevSubmit" href="${STATEMENT_DETAIL_PATH}">前へ</a>`
    : "<span>前へ</span>";
  const next = config.currentPage < config.totalPages
    ? `<a name="nextSubmit" class="nablarch_nextSubmit" href="${STATEMENT_DETAIL_PATH}">次へ</a>`
    : "<span>次へ</span>";
  return `<!doctype html><html><head><title>利用明細照会</title></head><body>
    ${authenticatedNavigation()}
    <form name="nablarch_form5" method="post">
      <div class="nablarch_paging">
        <div class="resultCountHeader">検索結果 ${config.resultCount}件</div>
        <div class="nablarch_currentPageNumber">[${config.currentPage}/${config.totalPages}ページ]</div>
        ${previous}${next}
      </div>
      ${table}
      <input name="nablarch_hidden" type="hidden" value="page-${config.currentPage}-state">
      <input name="nablarch_submit" type="hidden" value="">
    </form>
  </body></html>`;
}

export function jstDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - 9 * 60 * 60 * 1000);
}

function authenticatedNavigation(hidden = "navigation-state"): string {
  return `<form name="nablarch_form2" method="post">
      <a name="nablarch_form2_1" href="${LOGOUT_PATH}">ログアウト</a>
      <input name="nablarch_hidden" type="hidden" value="logout-state">
      <input name="nablarch_submit" type="hidden" value="">
    </form>
    <form name="nablarch_form3" method="post">
      <a name="nablarch_form3_1" href="${HOME_PATH}">TOP</a>
      <a name="nablarch_form3_2" href="${STATEMENT_INDEX_PATH}">利用明細照会</a>
      <input name="nablarch_needs_hidden_encryption" type="hidden" value="">
      <input name="nablarch_hidden" type="hidden" value="${hidden}">
      <input name="nablarch_submit" type="hidden" value="">
    </form>`;
}

function transactionRows(transaction: TestTransaction): string {
  return `<tr>
      <td rowspan="2">${escapeHTML(transaction.date)}</td>
      <td rowspan="2" class="left break">${escapeHTML(transaction.merchant)}</td>
      <td>${escapeHTML(transaction.transactionAmount)}</td>
      <td class="right"></td><td class="right"></td><td class="right"></td>
      <td rowspan="2">${escapeHTML(transaction.status ?? "")}</td>
      <td rowspan="2">${escapeHTML(transaction.approvalNumber ?? "")}</td>
      <td rowspan="2">${escapeHTML(transaction.note ?? "")}</td>
    </tr><tr>
      <td class="right dotted">${escapeHTML(transaction.usageAmount ?? "")}</td>
      <td class="right dotted"></td><td class="right dotted"></td><td class="right dotted"></td>
    </tr>`;
}

function escapeHTML(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
