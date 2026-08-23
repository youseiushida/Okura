import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert/";
import type { AmazonModule } from "../adapter/amazon/mod.ts";
import type { JCBModule } from "../adapter/jcb/mod.ts";
import type { CashOut } from "../model/transaction.ts";
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

class FakeAuthentication<Provider extends ProviderID, Credentials>
  implements AuthenticationPort<Provider, Credentials> {
  readonly provider: Provider;
  validation: SessionValidation = { status: "valid" };
  restoreResult: SessionRestoreResult = { status: "restored" };
  loginHandler: (credentials: Credentials, options: LoginOptions) => Promise<void> = () =>
    Promise.resolve();
  loginCount = 0;
  valid = false;

  constructor(provider: Provider) {
    this.provider = provider;
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
    _key: SessionKey<Provider>,
    _options?: SessionVaultOptions,
  ): Promise<void> {
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
  const parsed = parseAmazonFetchArguments(["--from", "2026-08-01", "--to", "2026-08-23"]);
  assertEquals(parsed.walletID, "amazon");
  assertEquals(parsed.profile, "default");
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
  vault.loaded = {
    schemaVersion: 1,
    provider: "amazon",
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
    }),
  );
  assertEquals(auth.loginCount, 0);
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
    ...overrides,
  };
}

function jcbModule(
  auth: FakeAuthentication<"jcb", JCBFakeCredentials>,
  cashOuts: CashOut[],
): JCBModule {
  return {
    auth,
    sources: { cashOuts: { fetchCashOuts: () => Promise.resolve(cashOuts) } },
  };
}

function amazonModule(
  auth: FakeAuthentication<"amazon", AmazonFakeCredentials>,
  cashOuts: CashOut[],
): AmazonModule {
  return {
    auth,
    sources: { cashOuts: { fetchCashOuts: () => Promise.resolve(cashOuts) } },
  };
}

function cashOut(): CashOut {
  return {
    id: `jcb:${"a".repeat(64)}`,
    amount: 908,
    occurredAt: new Date("2026-06-17T15:00:00.000Z"),
    from: "wallet-jcb",
    to: { name: "ＣＬＯＵＤＦＬＡＲＥ", metadata: { source: "jcb" } },
  };
}

function amazonCashOut(): CashOut {
  return {
    id: "amazon:123-4567890-1234567",
    amount: 1280,
    occurredAt: new Date("2026-08-19T15:00:00.000Z"),
    from: "amazon",
    to: { name: "Amazon.co.jp", metadata: { source: "amazon" } },
  };
}
