export interface TestServer {
  url: string;
  close(): Promise<void>;
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

export function jstDate(year: number, month: number, day: number, hour = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour) - 9 * 60 * 60 * 1000);
}

export function statementHTML(...rows: string[][]): string {
  return statementHTMLWithDifferences(rows, []);
}

export function statementHTMLWithDifferences(
  settledRows: string[][],
  differenceRows: string[][],
): string {
  const settledHeaders = [
    "ご利用者",
    "お振替日",
    "ご利用先など",
    "お振替金額",
    "摘要",
    "承認番号",
  ];
  const differenceHeaders = [
    "ご利用者",
    "差額発生日",
    "ご利用先など",
    "差額",
    "摘要",
    "お取引結果",
    "承認番号",
  ];
  return `<html><body><table class="unrelated"></table>` +
    statementTable(settledHeaders, settledRows) +
    statementTable(differenceHeaders, differenceRows) +
    `</body></html>`;
}

function statementTable(headers: string[], rows: string[][]): string {
  return `<table class="table_detail02 usage_detail-table01"><thead><tr>` +
    headers.map((header) => `<th>${header}</th>`).join("") +
    `</tr></thead><tbody>` +
    rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("") +
    `</tbody></table>`;
}

export function authenticatedMypageHTML(): string {
  return `<!doctype html><html><body>
    <header><a name="toHeaderUserLogout" href="/iss-pc/member/user_manage/userLogout.html">
      ログアウト
    </a></header>
    <nav><a name="toNaviDebitDetailMenu"
      href="/iss-pc/member/debit/details/debitDetailMenu.html">ご利用明細</a></nav>
  </body></html>`;
}

export function expiredMypageHTML(): string {
  return `<!doctype html><html><body><div class="wrapper error">
    <h2>通信エラーが発生しました</h2>
    <a href="/support/pop/myjcberror.html">通信エラー原因について</a>
  </div></body></html>`;
}

export function hasCause(
  error: unknown,
  predicate: (error: Error) => boolean,
): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (predicate(current)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}
