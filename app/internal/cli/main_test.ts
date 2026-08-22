import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert/";
import type { CashOut } from "../model/transaction.ts";
import { formatCashOuts, parseJCBFetchArguments, runCLI } from "./main.ts";

Deno.test("parseJCBFetchArguments treats CLI dates as an inclusive JST range", () => {
  const parsed = parseJCBFetchArguments([
    "--from",
    "2026-06-16",
    "--to",
    "2026-07-15",
    "--wallet-id",
    "wallet-jcb",
    "--format",
    "json",
  ]);
  assertEquals(parsed.walletID, "wallet-jcb");
  assertEquals(parsed.period.from.toISOString(), "2026-06-15T15:00:00.000Z");
  assertEquals(parsed.period.to.toISOString(), "2026-07-15T15:00:00.000Z");
  assertEquals(parsed.format, "json");
});

Deno.test("parseJCBFetchArguments rejects invalid ranges", () => {
  assertThrows(
    () => parseJCBFetchArguments(["--from", "2026-08-20", "--to", "2026-08-19"]),
    TypeError,
  );
  assertThrows(
    () => parseJCBFetchArguments(["--from", "2026-02-30", "--to", "2026-03-01"]),
    TypeError,
  );
});

Deno.test("runCLI obtains credentials and prints fetched cash outs", async () => {
  const writes: string[] = [];
  let loginCredentials = { userID: "", password: "" };
  const result = await runCLI(
    ["jcb", "fetch", "--from", "2026-06-16", "--to", "2026-07-15"],
    {
      getEnv: () => undefined,
      askText: () => Promise.resolve("har-user"),
      askSecret: () => Promise.resolve("har-password"),
      write: (message) => writes.push(message),
      createJCB: () => ({
        login(credentials) {
          loginCredentials = credentials;
          return Promise.resolve();
        },
        fetchCashOuts() {
          return Promise.resolve([cashOut()]);
        },
      }),
    },
  );
  assertEquals(result, 0);
  assertEquals(loginCredentials, { userID: "har-user", password: "har-password" });
  assertStringIncludes(writes.join("\n"), "2026-06-18\t908円\tＣＬＯＵＤＦＬＡＲＥ");
});

Deno.test("runCLI does not fetch when credentials are missing", async () => {
  await assertRejects(
    () =>
      runCLI(
        ["jcb", "fetch", "--from", "2026-06-16", "--to", "2026-07-15"],
        {
          getEnv: () => undefined,
          askText: () => Promise.resolve(""),
          askSecret: () => Promise.resolve(""),
          write: () => {},
          createJCB: () => {
            throw new Error("must not create adapter");
          },
        },
      ),
    TypeError,
  );
});

Deno.test("formatCashOuts emits machine-readable JSON", () => {
  const output = formatCashOuts(
    [cashOut()],
    parseJCBFetchArguments([
      "--from",
      "2026-06-16",
      "--to",
      "2026-07-15",
      "--format",
      "json",
    ]),
  );
  const parsed = JSON.parse(output);
  assertEquals(parsed.count, 1);
  assertEquals(parsed.totalAmount, 908);
  assertEquals(parsed.cashOuts[0].date, "2026-06-18");
});

function cashOut(): CashOut {
  return {
    id: `jcb:${"a".repeat(64)}`,
    amount: 908,
    occurredAt: new Date("2026-06-17T15:00:00.000Z"),
    from: "wallet-jcb",
    to: { name: "ＣＬＯＵＤＦＬＡＲＥ", metadata: { source: "jcb" } },
  };
}
