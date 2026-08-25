import { assertEquals } from "@std/assert/";
import { createProviderConnection } from "../model/connection.ts";
import { amazonCashOut, jcbCashIn, jcbCashOut } from "../testing/financial.ts";
import { presentCashFlow, presentCashOuts } from "./presenter.ts";

Deno.test("presentCashFlow emits incoming and outgoing JCB data as JSON", () => {
  const output = presentCashFlow({
    connection: createProviderConnection("jcb", "default"),
    authentication: {
      session: "reused",
      persistence: { status: "saved" },
      credentials: {
        status: "not-required",
        persistence: { status: "not-requested" },
      },
    },
    cashIns: [jcbCashIn()],
    cashOuts: [jcbCashOut()],
  }, {
    periodLabels: { from: "2026-06-16", to: "2026-07-15" },
    format: "json",
  });

  const parsed = JSON.parse(output);
  assertEquals(parsed.cashFlow.cashInCount, 1);
  assertEquals(parsed.cashFlow.cashOutCount, 1);
  assertEquals(parsed.cashFlow.totalCashInAmount, 500);
  assertEquals(parsed.cashFlow.totalCashOutAmount, 908);
  assertEquals(parsed.cashFlow.cashIns[0].date, "2026-06-19");
  assertEquals(parsed.cashFlow.cashOuts[0].date, "2026-06-18");
});

Deno.test("presentCashOuts shows Amazon item titles in the table", () => {
  const cashOut = amazonCashOut();
  const output = presentCashOuts({
    connection: createProviderConnection("amazon", "default"),
    authentication: {
      session: "reused",
      persistence: { status: "saved" },
      credentials: {
        status: "not-required",
        persistence: { status: "not-requested" },
      },
    },
    cashOuts: [{
      ...cashOut,
      to: {
        ...cashOut.to,
        metadata: { ...cashOut.to.metadata, items: "ほしいも 500g | 緑茶" },
      },
    }],
  }, {
    periodLabels: { from: "2026-08-01", to: "2026-08-23" },
    format: "table",
  });

  assertEquals(
    output.includes("日付\t金額\t商品名\n2026-08-20\t1280円\tほしいも 500g | 緑茶"),
    true,
  );
  assertEquals(output.includes("Amazon.co.jp"), false);
});

Deno.test("presentCashOuts marks a missing Amazon item title explicitly", () => {
  const output = presentCashOuts({
    connection: createProviderConnection("amazon", "default"),
    authentication: {
      session: "reused",
      persistence: { status: "saved" },
      credentials: {
        status: "not-required",
        persistence: { status: "not-requested" },
      },
    },
    cashOuts: [amazonCashOut()],
  }, {
    periodLabels: { from: "2026-08-01", to: "2026-08-23" },
    format: "table",
  });

  assertEquals(output.includes("（商品名を取得できませんでした）"), true);
  assertEquals(output.includes("Amazon.co.jp"), false);
});
