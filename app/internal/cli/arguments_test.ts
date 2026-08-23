import { assertEquals, assertThrows } from "@std/assert/";
import {
  parseAmazonFetchArguments,
  parseJCBFetchArguments,
  parseMoneyForwardFetchArguments,
} from "./arguments.ts";

Deno.test("JCB fetch arguments use an inclusive JST range", () => {
  const parsed = parseJCBFetchArguments([
    "--from",
    "2026-06-16",
    "--to",
    "2026-07-15",
    "--wallet-id",
    "wallet-jcb",
    "--profile",
    "personal",
    "--format",
    "json",
  ]);

  assertEquals(parsed.walletID, "wallet-jcb");
  assertEquals(parsed.connection.profile, "personal");
  assertEquals(parsed.connection.id, "jcb/personal");
  assertEquals(parsed.period.from.toISOString(), "2026-06-15T15:00:00.000Z");
  assertEquals(parsed.period.to.toISOString(), "2026-07-15T15:00:00.000Z");
  assertEquals(parsed.format, "json");
});

Deno.test("fetch arguments reject invalid ranges", () => {
  assertThrows(
    () => parseJCBFetchArguments(["--from", "2026-08-20", "--to", "2026-08-19"]),
    TypeError,
  );
  assertThrows(
    () => parseJCBFetchArguments(["--from", "2026-02-30", "--to", "2026-03-01"]),
    TypeError,
  );
});

Deno.test("Amazon fetch arguments use the default wallet and profile", () => {
  const parsed = parseAmazonFetchArguments([
    "--from",
    "2026-08-01",
    "--to",
    "2026-08-23",
    "--reauth",
    "--save-credentials",
  ]);

  assertEquals(parsed.walletID, "amazon");
  assertEquals(parsed.connection.profile, "default");
  assertEquals(parsed.connection.id, "amazon/default");
  assertEquals(parsed.reauthenticate, true);
  assertEquals(parsed.saveCredentials, true);
  assertEquals(parsed.period.from.toISOString(), "2026-07-31T15:00:00.000Z");
  assertEquals(parsed.period.to.toISOString(), "2026-08-23T15:00:00.000Z");
});

Deno.test("Money Forward fetch arguments reject a fixed wallet", () => {
  const parsed = parseMoneyForwardFetchArguments([
    "--from",
    "2026-07-01",
    "--to",
    "2026-08-23",
  ]);

  assertEquals(parsed.period.from.toISOString(), "2026-06-30T15:00:00.000Z");
  assertEquals(parsed.period.to.toISOString(), "2026-08-23T15:00:00.000Z");
  assertThrows(
    () =>
      parseMoneyForwardFetchArguments([
        "--from",
        "2026-07-01",
        "--to",
        "2026-08-23",
        "--wallet-id",
        "single-wallet",
      ]),
    TypeError,
  );
});
