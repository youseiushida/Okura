import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert/";
import { FetchCashOuts, FetchFinancialSnapshot } from "../application/fetch.ts";
import { storedPasswordCredential } from "../application/credentials.ts";
import { createProviderConnection } from "../model/connection.ts";
import type { CashOut } from "../model/transaction.ts";
import {
  FakeAuthentication,
  FakeCredentialVault,
  FakeSessionVault,
} from "../testing/authentication.ts";
import {
  amazonCashOut,
  jcbCashOut,
  moneyForwardAssetBalance,
  moneyForwardCashIn,
  moneyForwardCashOut,
  moneyForwardTransfer,
} from "../testing/financial.ts";
import { runCLI } from "./main.ts";
import type { CLIEnvironment } from "./runtime.ts";

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

Deno.test("runCLI obtains JCB credentials through AuthenticationPort", async () => {
  const writes: string[] = [];
  const vault = new FakeSessionVault();
  const auth = new FakeAuthentication<"jcb", JCBFakeCredentials>("jcb");
  const credentialVault = new FakeCredentialVault();
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
      createJCBFetch: () => jcbFetch(auth, vault, [jcbCashOut()], credentialVault),
    }),
  );
  assertEquals(result, 0);
  assertEquals(loginCredentials, { userID: "har-user", password: "har-password" });
  assertEquals(vault.saved?.provider, "jcb");
  assertEquals(credentialVault.saveCount, 0);
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
          createJCBFetch: () =>
            new FetchCashOuts({
              authentication: auth,
              sessionVault: vault,
              credentialVault: new FakeCredentialVault(),
              cashOuts: {
                fetchCashOuts: () => {
                  fetched = true;
                  return Promise.resolve([]);
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

Deno.test("runCLI obtains Amazon credentials and OTP through the central interaction", async () => {
  const writes: string[] = [];
  const vault = new FakeSessionVault();
  const auth = new FakeAuthentication<"amazon", AmazonFakeCredentials>("amazon");
  const credentialVault = new FakeCredentialVault();
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
    [
      "amazon",
      "fetch",
      "--from",
      "2026-08-01",
      "--to",
      "2026-08-23",
      "--save-credentials",
    ],
    testEnvironment({
      getEnv: () => undefined,
      askText: (message) =>
        Promise.resolve(message.includes("verification") ? "123456" : "user\\@example.com"),
      askSecret: () => Promise.resolve("amazon-password"),
      write: (message) => writes.push(message),
      createAmazonFetch: () => amazonFetch(auth, vault, [amazonCashOut()], credentialVault),
    }),
  );
  assertEquals(result, 0);
  assertEquals(credentials, { email: "user@example.com", password: "amazon-password" });
  assertEquals(verificationCode, "123456");
  assertEquals(
    credentialVault.saved,
    storedPasswordCredential(
      createProviderConnection("amazon", "default"),
      "user@example.com",
      "amazon-password",
    ),
  );
  assertEquals(JSON.stringify(credentialVault.saved).includes(verificationCode), false);
  assertEquals(writes.join("\n").includes("user@example.com"), false);
  assertEquals(writes.join("\n").includes("amazon-password"), false);
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
  const credentialVault = new FakeCredentialVault();
  await runCLI(
    ["amazon", "fetch", "--from", "2026-08-01", "--to", "2026-08-23"],
    testEnvironment({
      getEnv: () => {
        throw new Error("credentials must not be read");
      },
      askText: () => Promise.reject(new Error("credentials must not be requested")),
      askSecret: () => Promise.reject(new Error("credentials must not be requested")),
      createAmazonFetch: () => amazonFetch(auth, vault, [], credentialVault),
      warn: (message) => warnings.push(message),
    }),
  );
  assertEquals(auth.loginCount, 0);
  assertEquals(credentialVault.loadCount, 0);
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
      createAmazonFetch: () => amazonFetch(auth, vault, []),
    }),
  );

  assertEquals(auth.loginCount, 1);
  assertEquals(vault.removed?.id, "amazon/default");
});

Deno.test("runCLI --reauth retains and uses a saved credential", async () => {
  const vault = new FakeSessionVault();
  vault.loaded = {
    schemaVersion: 1,
    provider: "amazon",
    connectionID: createProviderConnection("amazon", "default").id,
    capturedAt: "2026-08-23T00:00:00.000Z",
    payload: {},
  };
  const auth = new FakeAuthentication<"amazon", AmazonFakeCredentials>("amazon");
  const credentialVault = new FakeCredentialVault();
  credentialVault.loaded = storedPasswordCredential(
    createProviderConnection("amazon", "default"),
    "saved@example.test",
    "saved-password",
  );
  let loginCredentials: AmazonFakeCredentials | undefined;
  auth.loginHandler = (credentials) => {
    loginCredentials = credentials;
    return Promise.resolve();
  };

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
      getEnv: () => undefined,
      askText: () => Promise.reject(new Error("prompt not expected")),
      askSecret: () => Promise.reject(new Error("prompt not expected")),
      createAmazonFetch: () => amazonFetch(auth, vault, [], credentialVault),
    }),
  );

  assertEquals(loginCredentials, { email: "saved@example.test", password: "saved-password" });
  assertEquals(credentialVault.removeCount, 0);
});

Deno.test("runCLI does not mix a partial environment credential with keyring data", async () => {
  const vault = new FakeSessionVault();
  const auth = new FakeAuthentication<"amazon", AmazonFakeCredentials>("amazon");
  const credentialVault = new FakeCredentialVault();
  credentialVault.loaded = storedPasswordCredential(
    createProviderConnection("amazon", "default"),
    "saved@example.test",
    "saved-password",
  );
  let loginCredentials: AmazonFakeCredentials | undefined;
  auth.loginHandler = (credentials) => {
    loginCredentials = credentials;
    return Promise.resolve();
  };

  await runCLI(
    ["amazon", "fetch", "--from", "2026-08-01", "--to", "2026-08-23"],
    testEnvironment({
      getEnv: (name) => name === "AMAZON_EMAIL" ? "env@example.test" : undefined,
      askSecret: () => Promise.resolve("prompt-password"),
      createAmazonFetch: () => amazonFetch(auth, vault, [], credentialVault),
    }),
  );

  assertEquals(loginCredentials, { email: "env@example.test", password: "prompt-password" });
  assertEquals(credentialVault.loadCount, 0);
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

Deno.test("runCLI removes only credentials for the selected connection", async () => {
  const sessionVault = new FakeSessionVault();
  const credentialVault = new FakeCredentialVault();
  const writes: string[] = [];

  const result = await runCLI(
    ["moneyforward", "credentials", "remove", "--profile", "personal"],
    testEnvironment({
      createSessionVault: () => sessionVault,
      createCredentialVault: () => credentialVault,
      write: (message) => writes.push(message),
    }),
  );

  assertEquals(result, 0);
  assertEquals(credentialVault.removed, createProviderConnection("moneyforward", "personal"));
  assertEquals(sessionVault.removed, undefined);
  assertStringIncludes(writes.join("\n"), "saved session was retained");
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
      createMoneyForwardFetch: () => moneyForwardFetch(auth, vault),
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

function testEnvironment(overrides: Partial<CLIEnvironment>): CLIEnvironment {
  return {
    getEnv: () => undefined,
    askText: () => Promise.resolve(""),
    askSecret: () => Promise.resolve(""),
    write: () => {},
    warn: () => {},
    createSessionVault: () => new FakeSessionVault(),
    createCredentialVault: () => new FakeCredentialVault(),
    createJCBFetch: () => {
      throw new Error("unexpected JCB fetch use case creation");
    },
    createAmazonFetch: () => {
      throw new Error("unexpected Amazon fetch use case creation");
    },
    createMoneyForwardFetch: () => {
      throw new Error("unexpected Money Forward fetch use case creation");
    },
    ...overrides,
  };
}

function jcbFetch(
  auth: FakeAuthentication<"jcb", JCBFakeCredentials>,
  vault: FakeSessionVault,
  cashOuts: CashOut[],
  credentialVault = new FakeCredentialVault(),
): FetchCashOuts<"jcb", JCBFakeCredentials> {
  return new FetchCashOuts({
    authentication: auth,
    sessionVault: vault,
    credentialVault,
    cashOuts: { fetchCashOuts: () => Promise.resolve(cashOuts) },
  });
}

function amazonFetch(
  auth: FakeAuthentication<"amazon", AmazonFakeCredentials>,
  vault: FakeSessionVault,
  cashOuts: CashOut[],
  credentialVault = new FakeCredentialVault(),
): FetchCashOuts<"amazon", AmazonFakeCredentials> {
  return new FetchCashOuts({
    authentication: auth,
    sessionVault: vault,
    credentialVault,
    cashOuts: { fetchCashOuts: () => Promise.resolve(cashOuts) },
  });
}

function moneyForwardFetch(
  auth: FakeAuthentication<"moneyforward", MoneyForwardFakeCredentials>,
  vault: FakeSessionVault,
  credentialVault = new FakeCredentialVault(),
): FetchFinancialSnapshot<"moneyforward", MoneyForwardFakeCredentials> {
  return new FetchFinancialSnapshot({
    authentication: auth,
    sessionVault: vault,
    credentialVault,
    assetBalances: { fetchAssetBalances: () => Promise.resolve([moneyForwardAssetBalance()]) },
    cashIns: { fetchCashIns: () => Promise.resolve([moneyForwardCashIn()]) },
    cashOuts: { fetchCashOuts: () => Promise.resolve([moneyForwardCashOut()]) },
    transfers: { fetchTransfers: () => Promise.resolve([moneyForwardTransfer()]) },
  });
}
