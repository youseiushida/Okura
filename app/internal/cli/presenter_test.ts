import { assertEquals } from "@std/assert/";
import { createProviderConnection } from "../model/connection.ts";
import { jcbCashOut } from "../testing/financial.ts";
import { presentCashOuts } from "./presenter.ts";

Deno.test("presentCashOuts emits machine-readable JSON", () => {
  const output = presentCashOuts({
    connection: createProviderConnection("jcb", "default"),
    authentication: {
      session: "reused",
      persistence: { status: "saved" },
      credentials: {
        status: "not-required",
        persistence: { status: "not-requested" },
      },
    },
    cashOuts: [jcbCashOut()],
  }, {
    periodLabels: { from: "2026-06-16", to: "2026-07-15" },
    format: "json",
  });

  const parsed = JSON.parse(output);
  assertEquals(parsed.count, 1);
  assertEquals(parsed.totalAmount, 908);
  assertEquals(parsed.cashOuts[0].date, "2026-06-18");
});
