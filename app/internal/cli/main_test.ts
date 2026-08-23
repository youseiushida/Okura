import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert/";
import type { AmazonModule } from "../adapter/amazon/mod.ts";
import type { JCBModule } from "../adapter/jcb/mod.ts";
import type { MoneyForwardModule } from "../adapter/moneyforward/mod.ts";
import { createWallet } from "../model/account.ts";
import { createProviderConnection, type ProviderConnection } from "../model/connection.ts";
import type { AssetBalance } from "../model/asset.ts";
import type { CashIn, CashOut, Transfer } from "../model/transaction.ts";
import type {
  AuthenticationOptions,
  AuthenticationPort,
  LoginOptions,
  ProviderSessionSnapshot,
  SessionRestoreResult,
  SessionValidation,
} from "../port/authentication.ts";
import type { ProviderID } from "../port/provider.ts";
import type { SessionKey, SessionVaultOptions, SessionVaultPort } from "../port/session_vault.ts";
import {
  type CLIEnvironment,
  formatCashOuts,
  parseAmazonFetchArguments,
  parseJCBFetchArguments,
  parseMoneyForwardFetchArguments,
  runCLI,
} from "./main.ts";

interface JCBFakeCredentials {
  readonly userID: string;
  readonly password: string;
}

interface AmazonFakeCredentials {
  readonly email: string;
  readonly password: string;
}

interface MoneyForwardFakeCredentials {
  readonly email: string;
  readonly password: string;
}

class FakeAuthentication<Provider extends ProviderID, Credentials>
  implements AuthenticationPort<Provider, Credentials> {
  readonly provider: Provider;
  readonly connection: ProviderConnection<Provider>;
  validation: SessionValidation = { status: "valid" };
  restoreResult: SessionRestoreResult = { status: "restored" };
  loginHandler: (credentials: Credentials, options: LoginOptions) => Promise<void> = () =>
    Promise.resolve();
  loginCount = 0;
  valid = false;

  constructor(provider: Provider, profile = "default") {
    this.provider = provider;
    this.connection = createProviderConnection(provider, profile);
  }

  restoreSession(_snapshot: unknown): SessionRestoreResult {
    this.valid = false;
    return this.restoreResult;
  }

  validateSession(_options?: AuthenticationOptions): Promise<SessionValidation> {
    this.valid = this.validation.status === "valid";
    return Promise.resolve(this.validation);
  }

  async login(credentials: Credentials, options: LoginOptions): Promise<void> {
    this.loginCount += 1;
    await this.loginHandler(credentials, options);
    this.valid = true;
  }

  captureSession(): ProviderSessionSnapshot<Provider> {
    if (!this.valid) throw new Error("not authenticated");
    return {
      schemaVersion: 1,
      provider: this.provider,
      connectionID: this.connection.id,
      capturedAt: "2026-08-23T00:00:00.000Z",
      payload: {},
    };
  }

  clearSession(): void {
    this.valid = false;
  }
}

class FakeSessionVault implements SessionVaultPort {
  loaded: unknown | undefined;
  saved?: ProviderSessionSnapshot;
  removed?: SessionKey;

  load<Provider extends ProviderID>(
    _key: SessionKey<Provider>,
    _options?: SessionVaultOptions,
  ): Promise<unknown | undefined> {
    return Promise.resolve(this.loaded);
  }

  save<Provider extends ProviderID>(
    _key: SessionKey<Provider>,
    snapshot: ProviderSessionSnapshot<Provider>,
    _options?: SessionVaultOptions,
  ): Promise<void> {
    this.saved = snapshot;
    this.loaded = snapshot;
    return Promise.resolve();
  }

  remove<Provider extends ProviderID>(
    key: SessionKey<Provider>,
    _options?: SessionVaultOptions,
  ): Promise<void> {
    this.removed = key;
    this.loaded = undefined;
    return Promise.resolve();
  }
}

Deno.test("parseJCBFetchArguments treats CLI dates as an inclusive JST range", () => {
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
  assertEquals(parsed.profile, "personal");
  assertEquals(parsed.connection.id, "jcb/personal");
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

Deno.test("runCLI obtains JCB credentials through AuthenticationPort", async () => {
  const writes: string[] = [];
  const vault = new FakeSessionVault();
  const auth = new FakeAuthentication<"jcb", JCBFakeCredentials>("jcb");
  let loginCredentials = { userID: "", password: "" };
  auth.loginHandler = (credentials) => {
    loginCredentials = credentials;
    return Promise.resolve();
  };
  const result = await runCLI(
    ["jcb", "fetch", "--from", "2026-06-16", "--to", "2026-07-15"],
    testEnvironment({
      getEnv: () => undefined,
      askText: () => Promise.resolve("har-user"),
      askSecret: () => Promise.resolve("har-password"),
      write: (message) => writes.push(message),
      createSessionVault: () => vault,
      createJCB: () => jcbModule(auth, [cashOut()]),
    }),
  );
  assertEquals(result, 0);
  assertEquals(loginCredentials, { userID: "har-user", password: "har-password" });
  assertEquals(vault.saved?.provider, "jcb");
  assertStringIncludes(writes.join("\n"), "2026-06-18\t908円\tＣＬＯＵＤＦＬＡＲＥ");
});

Deno.test("runCLI does not fetch when JCB credentials are missing", async () => {
  const vault = new FakeSessionVault();
  const auth = new FakeAuthentication<"jcb", JCBFakeCredentials>("jcb");
  let fetched = false;
  await assertRejects(
    () =>
      runCLI(
        ["jcb", "fetch", "--from", "2026-06-16", "--to", "2026-07-15"],
        testEnvironment({
          getEnv: () => undefined,
          askText: () => Promise.resolve(""),
          askSecret: () => Promise.resolve(""),
          createSessionVault: () => vault,
          createJCB: () => ({
            connection: auth.connection,
            auth,
            sources: {
              cashOuts: {
                fetchCashOuts: () => {
                  fetched = true;
                  return Promise.resolve([]);
                },
              },
            },
          }),
        }),
      ),
    TypeError,
  );
  assertEquals(fetched, false);
  assertEquals(auth.loginCount, 0);
});

Deno.test("parseAmazonFetchArguments uses the amazon wallet and default profile", () => {
  const parsed = parseAmazonFetchArguments([
    "--from",
    "2026-08-01",
    "--to",
    "2026-08-23",
    "--reauth",
  ]);
  assertEquals(parsed.walletID, "amazon");
  assertEquals(parsed.profile, "default");
  assertEquals(parsed.connection.id, "amazon/default");
  assertEquals(parsed.reauthenticate, true);
  assertEquals(parsed.period.from.toISOString(), "2026-07-31T15:00:00.000Z");
  assertEquals(parsed.period.to.toISOString(), "2026-08-23T15:00:00.000Z");
});

Deno.test("runCLI obtains Amazon credentials and OTP through the central interaction", async () => {
  const writes: string[] = [];
  const vault = new FakeSessionVault();
  const auth = new FakeAuthentication<"amazon", AmazonFakeCredentials>("amazon");
  let credentials = { email: "", password: "" };
  let verificationCode = "";
  auth.loginHandler = async (value, options) => {
    credentials = value;
    const reply = await options.interaction.otp.request({
      provider: "amazon",
      step: "login-otp",
      attempt: 1,
      channel: "sms",
      format: "numeric",
      resend: { allowed: false },
    });
    if (reply.action === "submit") verificationCode = reply.code;
  };
  const result = await runCLI(
    ["amazon", "fetch", "--from", "2026-08-01", "--to", "2026-08-23"],
    testEnvironment({
      getEnv: () => undefined,
      askText: (message) =>
        Promise.resolve(message.includes("verification") ? "123456" : "user\\@example.com"),
      askSecret: () => Promise.resolve("amazon-password"),
      write: (message) => writes.push(message),
      createSessionVault: () => vault,
      createAmazon: () => amazonModule(auth, [amazonCashOut()]),
    }),
  );
  assertEquals(result, 0);
  assertEquals(credentials, { email: "user@example.com", password: "amazon-password" });
  assertEquals(verificationCode, "123456");
  assertStringIncludes(writes.join("\n"), "2026-08-20\t1280円\tAmazon.co.jp");
});

Deno.test("runCLI reuses a valid saved session without asking for credentials", async () => {
  const vault = new FakeSessionVault();
  const warnings: string[] = [];
  vault.loaded = {
    schemaVersion: 1,
    provider: "amazon",
    connectionID: createProviderConnection("amazon", "default").id,
    capturedAt: "2026-08-23T00:00:00.000Z",
    payload: {},
  };
  const auth = new FakeAuthentication<"amazon", AmazonFakeCredentials>("amazon");
  await runCLI(
    ["amazon", "fetch", "--from", "2026-08-01", "--to", "2026-08-23"],
    testEnvironment({
      getEnv: () => {
        throw new Error("credentials must not be read");
      },
      askText: () => Promise.reject(new Error("credentials must not be requested")),
      askSecret: () => Promise.reject(new Error("credentials must not be requested")),
      createSessionVault: () => vault,
      createAmazon: () => amazonModule(auth, []),
      warn: (message) => warnings.push(message),
    }),
  );
  assertEquals(auth.loginCount, 0);
  assertStringIncludes(warnings.join("\n"), "amazon/default (saved session)");
});

Deno.test("runCLI --reauth removes a saved session and performs a new login", async () => {
  const vault = new FakeSessionVault();
  vault.loaded = {
    schemaVersion: 1,
    provider: "amazon",
    connectionID: createProviderConnection("amazon", "default").id,
    capturedAt: "2026-08-23T00:00:00.000Z",
    payload: {},
  };
  const auth = new FakeAuthentication<"amazon", AmazonFakeCredentials>("amazon");

  await runCLI(
    [
      "amazon",
      "fetch",
      "--from",
      "2026-08-01",
      "--to",
      "2026-08-23",
      "--reauth",
    ],
    testEnvironment({
      getEnv: (name) => name === "AMAZON_EMAIL" ? "person@example.com" : "password",
      createSessionVault: () => vault,
      createAmazon: () => amazonModule(auth, []),
    }),
  );

  assertEquals(auth.loginCount, 1);
  assertEquals(vault.removed?.id, "amazon/default");
});

Deno.test("runCLI removes only the selected saved session", async () => {
  const vault = new FakeSessionVault();
  const writes: string[] = [];

  const result = await runCLI(
    ["moneyforward", "session", "remove", "--profile", "personal"],
    testEnvironment({
      createSessionVault: () => vault,
      write: (message) => writes.push(message),
    }),
  );

  assertEquals(result, 0);
  assertEquals(vault.removed, createProviderConnection("moneyforward", "personal"));
  assertStringIncludes(writes.join("\n"), "moneyforward/personal");
});

Deno.test("runCLI fetches Money Forward assets, incomes, expenses, and email OTP", async () => {
  const writes: string[] = [];
  const vault = new FakeSessionVault();
  const auth = new FakeAuthentication<"moneyforward", MoneyForwardFakeCredentials>(
    "moneyforward",
  );
  let credentials = { email: "", password: "" };
  let otp = "";
  auth.loginHandler = async (value, options) => {
    credentials = value;
    const reply = await options.interaction.otp.request({
      provider: "moneyforward",
      step: "login-email-otp",
      attempt: 1,
      channel: "email",
      format: "numeric",
      length: { min: 6, max: 6 },
      resend: { allowed: false },
    });
    if (reply.action === "submit") otp = reply.code;
  };

  const result = await runCLI(
    [
      "moneyforward",
      "fetch",
      "--from",
      "2026-08-01",
      "--to",
      "2026-08-23",
      "--format",
      "json",
    ],
    testEnvironment({
      getEnv: () => undefined,
      askText: (message) =>
        Promise.resolve(message.includes("verification") ? "654321" : "person\\@example.com"),
      askSecret: () => Promise.resolve("mf-password"),
      write: (message) => writes.push(message),
      createSessionVault: () => vault,
      createMoneyForward: () => moneyForwardModule(auth),
    }),
  );

  assertEquals(result, 0);
  assertEquals(credentials, { email: "person@example.com", password: "mf-password" });
  assertEquals(otp, "654321");
  const output = JSON.parse(writes.at(-1)!);
  assertEquals(output.assets.count, 1);
  assertEquals(output.cashFlow.cashInCount, 1);
  assertEquals(output.cashFlow.cashOutCount, 1);
  assertEquals(output.cashFlow.transferCount, 1);
  assertEquals(output.connection.id, "moneyforward/default");
  assertEquals(output.cashFlow.cashIns[0].toWallet.name, "ゆうちょ");
  assertEquals(output.cashFlow.cashOuts[0].fromWallet.name, "財布・現金");
  assertEquals(output.cashFlow.transfers[0].fromWallet.name, "セブン銀行");
  assertEquals(output.cashFlow.transfers[0].toWallet.name, "ゆうちょ銀行");
  assertEquals("wallet_name" in output.cashFlow.cashOuts[0].metadata, false);
  assertEquals(
    new Set([
      output.cashFlow.cashIns[0].toWallet.id,
      output.cashFlow.cashOuts[0].fromWallet.id,
    ]).size,
    2,
  );
});

Deno.test("parseMoneyForwardFetchArguments uses an inclusive JST period", () => {
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

Deno.test("formatCashOuts rejects data from another connection", () => {
  const options = parseJCBFetchArguments([
    "--from",
    "2026-06-16",
    "--to",
    "2026-07-15",
    "--profile",
    "business",
  ]);
  assertThrows(() => formatCashOuts([cashOut()], options), TypeError);
});

function testEnvironment(overrides: Partial<CLIEnvironment>): CLIEnvironment {
  return {
    getEnv: () => undefined,
    askText: () => Promise.resolve(""),
    askSecret: () => Promise.resolve(""),
    write: () => {},
    warn: () => {},
    createSessionVault: () => new FakeSessionVault(),
    createJCB: () => {
      throw new Error("unexpected JCB module creation");
    },
    createAmazon: () => {
      throw new Error("unexpected Amazon module creation");
    },
    createMoneyForward: () => {
      throw new Error("unexpected Money Forward module creation");
    },
    ...overrides,
  };
}

function jcbModule(
  auth: FakeAuthentication<"jcb", JCBFakeCredentials>,
  cashOuts: CashOut[],
): JCBModule {
  return {
    connection: auth.connection,
    auth,
    sources: { cashOuts: { fetchCashOuts: () => Promise.resolve(cashOuts) } },
  };
}

function amazonModule(
  auth: FakeAuthentication<"amazon", AmazonFakeCredentials>,
  cashOuts: CashOut[],
): AmazonModule {
  return {
    connection: auth.connection,
    auth,
    sources: { cashOuts: { fetchCashOuts: () => Promise.resolve(cashOuts) } },
  };
}

function moneyForwardModule(
  auth: FakeAuthentication<"moneyforward", MoneyForwardFakeCredentials>,
): MoneyForwardModule {
  return {
    connection: auth.connection,
    auth,
    sources: {
      assetBalances: { fetchAssetBalances: () => Promise.resolve([assetBalance()]) },
      cashIns: { fetchCashIns: () => Promise.resolve([moneyForwardCashIn()]) },
      cashOuts: { fetchCashOuts: () => Promise.resolve([moneyForwardCashOut()]) },
      transfers: { fetchTransfers: () => Promise.resolve([moneyForwardTransfer()]) },
    },
  };
}

function cashOut(): CashOut {
  const connection = createProviderConnection("jcb", "default");
  return {
    id: `${connection.id}:transaction:${"a".repeat(64)}`,
    connectionID: connection.id,
    amount: 908,
    occurredAt: new Date("2026-06-17T15:00:00.000Z"),
    from: createWallet(connection, "wallet-jcb", "wallet-jcb"),
    to: { name: "ＣＬＯＵＤＦＬＡＲＥ", metadata: { source: "jcb" } },
  };
}

function amazonCashOut(): CashOut {
  const connection = createProviderConnection("amazon", "default");
  return {
    id: `${connection.id}:transaction:123-4567890-1234567`,
    connectionID: connection.id,
    amount: 1280,
    occurredAt: new Date("2026-08-19T15:00:00.000Z"),
    from: createWallet(connection, "amazon", "amazon"),
    to: { name: "Amazon.co.jp", metadata: { source: "amazon" } },
  };
}

function assetBalance(): AssetBalance {
  const connection = createProviderConnection("moneyforward", "default");
  return {
    asset: {
      id: `${connection.id}:asset:cash`,
      connectionID: connection.id,
      name: "現金資産",
      metadata: { source: "moneyforward" },
    },
    amount: 10_000,
    observedAt: new Date("2026-08-23T06:00:00.000Z"),
  };
}

function moneyForwardCashIn(): CashIn {
  const connection = createProviderConnection("moneyforward", "default");
  return {
    id: `${connection.id}:transaction:user_asset_act:income`,
    connectionID: connection.id,
    amount: 2_000,
    occurredAt: new Date("2026-08-19T15:00:00.000Z"),
    from: {
      name: "返金",
      metadata: { source: "moneyforward" },
    },
    to: createWallet(connection, "yucho", "ゆうちょ", { source: "moneyforward" }),
  };
}

function moneyForwardCashOut(): CashOut {
  const connection = createProviderConnection("moneyforward", "default");
  return {
    id: `${connection.id}:transaction:user_asset_act:expense`,
    connectionID: connection.id,
    amount: 800,
    occurredAt: new Date("2026-08-20T15:00:00.000Z"),
    from: createWallet(connection, "cash", "財布・現金", { source: "moneyforward" }),
    to: {
      name: "食料品店",
      metadata: { source: "moneyforward" },
    },
  };
}

function moneyForwardTransfer(): Transfer {
  const connection = createProviderConnection("moneyforward", "default");
  return {
    id: `${connection.id}:transaction:user_asset_act:transfer`,
    connectionID: connection.id,
    amount: 5_000,
    occurredAt: new Date("2026-08-21T15:00:00.000Z"),
    from: createWallet(connection, "seven", "セブン銀行", { source: "moneyforward" }),
    to: createWallet(connection, "yucho", "ゆうちょ銀行", { source: "moneyforward" }),
  };
}
