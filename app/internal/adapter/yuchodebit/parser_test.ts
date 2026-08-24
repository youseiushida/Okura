import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert/";
import { createWallet } from "../../model/account.ts";
import { createYuchoDebitContext } from "./context.ts";
import { UnexpectedPageError } from "./errors.ts";
import {
  parseLoginPage,
  parseNavigationSubmission,
  parsePageStatus,
  parseStatementMonths,
  parseStatementPage,
  submissionBody,
} from "./parser.ts";
import { STATEMENT_INDEX_PATH } from "./routes.ts";
import {
  authenticatedHomeHTML,
  expiredHTML,
  jstDate,
  loginHTML,
  statementIndexHTML,
  statementPageHTML,
} from "./test_util.ts";

const PAGE_URL = "https://www.debit.vpass.ne.jp/p/login/RW1312010001?cc=01010";

Deno.test("parseLoginPage extracts the public challenge and protected Nablarch submission", () => {
  const parsed = parseLoginPage(loginHTML(), PAGE_URL);

  assertEquals(parsed.challenge, {
    pageURL: PAGE_URL,
    siteKey: "test-site-key",
  });
  assertEquals(
    new URL(parsed.submission.action).pathname,
    "/p/login/RW1312010101;jsessionid=TEST.WEB000K01",
  );
  assertEquals(parsed.submission.submitName, "nablarch_form1_1");
  const body = submissionBody(parsed.submission, {
    usrId: "user",
    password: "password",
    "cf-turnstile-response": "token",
  });
  assertEquals(body.get("cc"), "01010");
  assertEquals(body.get("nablarch_hidden"), "login-state");
  assertEquals(body.get("nablarch_submit"), "nablarch_form1_1");
  assertEquals(body.get("cf-turnstile-response"), "token");
});

Deno.test("parsePageStatus distinguishes authenticated, expired, and unexpected pages", () => {
  assertEquals(parsePageStatus(authenticatedHomeHTML()), "authenticated");
  assertEquals(parsePageStatus(expiredHTML()), "expired");
  assertEquals(parsePageStatus("<html><head><title>障害</title></head></html>"), "unexpected");
});

Deno.test("parseNavigationSubmission and parseStatementMonths preserve Nablarch state", () => {
  const homeURL = "https://www.debit.vpass.ne.jp/p/top/RW1311010001?cc=01010";
  const navigation = parseNavigationSubmission(
    authenticatedHomeHTML("home-token"),
    homeURL,
    STATEMENT_INDEX_PATH,
  );
  assertEquals(submissionBody(navigation).get("nablarch_hidden"), "home-token");
  assertEquals(submissionBody(navigation).get("nablarch_submit"), "nablarch_form3_2");

  const months = parseStatementMonths(
    statementIndexHTML([
      { year: 2026, month: 8, referenceDate: "20260824" },
      { year: 2026, month: 7, referenceDate: "20260724" },
    ]),
    "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010101",
  );
  assertEquals(months.map(({ year, month, referenceDate }) => ({ year, month, referenceDate })), [
    { year: 2026, month: 8, referenceDate: "20260824" },
    { year: 2026, month: 7, referenceDate: "20260724" },
  ]);
  assertEquals(months[1]?.submission.submitName, "nablarch_form4_2");
});

Deno.test("parseNavigationSubmission normalizes validated desktop and mobile controls", () => {
  const duplicate = authenticatedHomeHTML("desktop-state").replace(
    "</body>",
    `<form name="nablarch_form4">
      <a name="nablarch_form4_1" href="${STATEMENT_INDEX_PATH}">利用明細照会</a>
      <input name="nablarch_hidden" type="hidden" value="mobile-state">
      <input name="nablarch_submit" type="hidden" value="">
    </form></body>`,
  );
  const parsed = parseNavigationSubmission(
    duplicate,
    "https://www.debit.vpass.ne.jp/p/login/RW1312010201?cc=01010",
    STATEMENT_INDEX_PATH,
  );
  assertEquals(parsed.submitName, "nablarch_form3_2");
  assertEquals(submissionBody(parsed).get("nablarch_hidden"), "desktop-state");

  assertThrows(
    () =>
      parseNavigationSubmission(
        duplicate.replace('value="mobile-state"', 'value=""'),
        "https://www.debit.vpass.ne.jp/p/login/RW1312010201?cc=01010",
        STATEMENT_INDEX_PATH,
      ),
    UnexpectedPageError,
    "missing Nablarch state",
  );
});

Deno.test("parseStatementPage maps domestic and converted foreign purchases", () => {
  const wallet = testWallet();
  const html = statementPageHTML({
    resultCount: 2,
    currentPage: 1,
    totalPages: 1,
    transactions: [
      {
        date: "2026/08/20",
        merchant: "国内店舗",
        transactionAmount: "JPY 1,234.00",
        approvalNumber: "123456",
        status: "確定",
      },
      {
        date: "2026/08/21",
        merchant: "FOREIGN STORE",
        transactionAmount: "USD 10.50",
        usageAmount: "JPY 1,680.00",
        approvalNumber: "654321",
        note: "海外利用",
      },
    ],
  });

  const parsed = parseStatementPage(
    html,
    "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010201",
    wallet,
  );
  assertEquals(parsed.resultCount, 2);
  assertEquals(parsed.cashOuts.length, 2);
  assertEquals(parsed.cashOuts[0]?.amount, 1234);
  assertEquals(parsed.cashOuts[0]?.occurredAt, jstDate(2026, 8, 20));
  assertEquals(parsed.cashOuts[0]?.to.name, "国内店舗");
  assertEquals(parsed.cashOuts[0]?.to.metadata.approval_number, "123456");
  assertEquals(parsed.cashOuts[1]?.amount, 1680);
  assertEquals(parsed.cashOuts[1]?.to.metadata.original_currency, "USD");
  assertEquals(parsed.cashOuts[1]?.to.metadata.original_amount, "10.50");
  assertMatch(parsed.cashOuts[0]?.id ?? "", /^yucho-debit\/default:transaction:[0-9a-f]{64}$/);
});

Deno.test("parseStatementPage rejects duplicate deterministic identities within a page", () => {
  const transaction = {
    date: "2026/08/20",
    merchant: "SAME SHOP",
    transactionAmount: "JPY 500.00",
  };

  assertThrows(
    () =>
      parseStatementPage(
        statementPageHTML({
          resultCount: 2,
          currentPage: 1,
          totalPages: 1,
          transactions: [transaction, transaction],
        }),
        "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010201",
        testWallet(),
      ),
    UnexpectedPageError,
    "duplicate identity",
  );
});

Deno.test("parseStatementPage counts refunds while omitting them from cash outs", () => {
  const parsed = parseStatementPage(
    statementPageHTML({
      resultCount: 2,
      currentPage: 1,
      totalPages: 1,
      transactions: [
        { date: "2026/08/20", merchant: "SHOP", transactionAmount: "JPY 500.00" },
        { date: "2026/08/21", merchant: "REFUND", transactionAmount: "JPY -500.00" },
      ],
    }),
    "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010201",
    testWallet(),
  );

  assertEquals(parsed.cashOuts.length, 1);
  assertEquals(parsed.cashOuts[0]?.to.name, "SHOP");
});

Deno.test("parseStatementPage preserves the sign of a sub-unit foreign refund", () => {
  const parsed = parseStatementPage(
    statementPageHTML({
      resultCount: 1,
      currentPage: 1,
      totalPages: 1,
      transactions: [{
        date: "2026/08/20",
        merchant: "FOREIGN REFUND",
        transactionAmount: "USD -0.50",
        usageAmount: "JPY -80.00",
      }],
    }),
    "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010201",
    testWallet(),
  );

  assertEquals(parsed.cashOuts, []);
});

Deno.test("parseStatementPage accepts explicit empty results and requires pagination controls", () => {
  const url = "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010201";
  const empty = parseStatementPage(
    statementPageHTML({
      resultCount: 0,
      currentPage: 0,
      totalPages: 0,
    }),
    url,
    testWallet(),
  );
  assertEquals(empty.cashOuts, []);

  const first = parseStatementPage(
    statementPageHTML({
      resultCount: 11,
      currentPage: 1,
      totalPages: 2,
      transactions: Array.from({ length: 10 }, (_, index) => ({
        date: "2026/08/20",
        merchant: `SHOP ${index}`,
        transactionAmount: "JPY 100.00",
      })),
    }),
    url,
    testWallet(),
  );
  assert(first.next !== undefined);
  assertEquals(submissionBody(first.next).get("nablarch_submit"), "nextSubmit");
  assertEquals(submissionBody(first.next).get("nablarch_hidden"), "page-1-state");
});

Deno.test("parseStatementPage fails closed on changed headers and count mismatches", () => {
  const valid = statementPageHTML({
    resultCount: 1,
    currentPage: 1,
    totalPages: 1,
    transactions: [{ date: "2026/08/20", merchant: "SHOP", transactionAmount: "JPY 100.00" }],
  });
  assertThrows(
    () =>
      parseStatementPage(
        valid.replace("お取引内容", "変更済み"),
        "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010201",
        testWallet(),
      ),
    UnexpectedPageError,
    "headers changed",
  );
  assertThrows(
    () =>
      parseStatementPage(
        valid.replace("検索結果 1件", "検索結果 2件"),
        "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010201",
        testWallet(),
      ),
    UnexpectedPageError,
  );
});

Deno.test("parseStatementPage rejects ambiguous JPY conversion values", () => {
  const html = statementPageHTML({
    resultCount: 1,
    currentPage: 1,
    totalPages: 1,
    transactions: [{
      date: "2026/08/20",
      merchant: "SHOP",
      transactionAmount: "JPY 100.00",
      usageAmount: "JPY 101.00",
    }],
  });
  assertThrows(
    () =>
      parseStatementPage(
        html,
        "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010201",
        testWallet(),
      ),
    UnexpectedPageError,
    "ambiguous",
  );
});

Deno.test("parseStatementPage rejects inconsistent foreign and JPY amount signs", () => {
  for (
    const [transactionAmount, usageAmount] of [
      ["USD -10.00", "JPY 1,680.00"],
      ["USD 10.00", "JPY -1,680.00"],
    ] as const
  ) {
    assertThrows(
      () =>
        parseStatementPage(
          statementPageHTML({
            resultCount: 1,
            currentPage: 1,
            totalPages: 1,
            transactions: [{
              date: "2026/08/20",
              merchant: "FOREIGN STORE",
              transactionAmount,
              usageAmount,
            }],
          }),
          "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010201",
          testWallet(),
        ),
      UnexpectedPageError,
      "inconsistent amount signs",
    );
  }
});

function testWallet() {
  const context = createYuchoDebitContext();
  return createWallet(context.connection, "wallet-yucho-debit", "ゆうちょデビット");
}
