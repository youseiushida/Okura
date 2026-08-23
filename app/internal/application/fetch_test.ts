import { assertEquals, assertRejects } from "@std/assert/";
import type { AuthInteraction } from "../port/auth_interaction.ts";
import type { EmailPasswordCredentials, UserIDPasswordCredentials } from "../port/credentials.ts";
import type { CredentialInput } from "./credentials.ts";
import { storedPasswordCredential } from "./credentials.ts";
import {
  FakeAuthentication,
  FakeCredentialVault,
  FakeSessionVault,
} from "../testing/authentication.ts";
import {
  jcbCashOut,
  moneyForwardAssetBalance,
  moneyForwardCashIn,
  moneyForwardCashOut,
  moneyForwardTransfer,
} from "../testing/financial.ts";
import { FetchCashOuts, FetchFinancialSnapshot } from "./fetch.ts";

const interaction: AuthInteraction = {
  otp: { request: () => Promise.resolve({ action: "submit", code: "unused" }) },
  progress: { publish: () => Promise.resolve() },
};

Deno.test("FetchCashOuts rejects source data from another connection", async () => {
  const authentication = new FakeAuthentication<"jcb", UserIDPasswordCredentials>(
    "jcb",
    "business",
  );
  const useCase = new FetchCashOuts({
    authentication,
    sessionVault: new FakeSessionVault(),
    credentialVault: new FakeCredentialVault(),
    cashOuts: { fetchCashOuts: () => Promise.resolve([jcbCashOut()]) },
  });

  await assertRejects(
    () =>
      useCase.execute({
        period: {
          from: new Date("2026-06-15T15:00:00.000Z"),
          to: new Date("2026-07-15T15:00:00.000Z"),
        },
        interaction,
        credentialInput: userIDInput({ userID: "user", password: "password" }),
      }),
    TypeError,
    "another connection",
  );
});

Deno.test("FetchFinancialSnapshot authenticates and obtains every financial source", async () => {
  const authentication = new FakeAuthentication<"moneyforward", EmailPasswordCredentials>(
    "moneyforward",
  );
  const calls: string[] = [];
  const useCase = new FetchFinancialSnapshot({
    authentication,
    sessionVault: new FakeSessionVault(),
    credentialVault: new FakeCredentialVault(),
    assetBalances: {
      fetchAssetBalances: () => {
        calls.push("assets");
        return Promise.resolve([moneyForwardAssetBalance()]);
      },
    },
    cashIns: {
      fetchCashIns: () => {
        calls.push("cash-ins");
        return Promise.resolve([moneyForwardCashIn()]);
      },
    },
    cashOuts: {
      fetchCashOuts: () => {
        calls.push("cash-outs");
        return Promise.resolve([moneyForwardCashOut()]);
      },
    },
    transfers: {
      fetchTransfers: () => {
        calls.push("transfers");
        return Promise.resolve([moneyForwardTransfer()]);
      },
    },
  });

  const result = await useCase.execute({
    period: {
      from: new Date("2026-07-31T15:00:00.000Z"),
      to: new Date("2026-08-23T15:00:00.000Z"),
    },
    interaction,
    credentialInput: emailInput({ email: "person@example.com", password: "password" }),
  });

  assertEquals(authentication.loginCount, 1);
  assertEquals(calls, ["assets", "cash-ins", "cash-outs", "transfers"]);
  assertEquals(result.assetBalances.length, 1);
  assertEquals(result.cashIns.length, 1);
  assertEquals(result.cashOuts.length, 1);
  assertEquals(result.transfers.length, 1);
});

function userIDInput(
  credentials: UserIDPasswordCredentials,
): CredentialInput<"jcb", UserIDPasswordCredentials> {
  return {
    readEnvironment: () => Promise.resolve(undefined),
    prompt: () => Promise.resolve(credentials),
    fromStored: (stored) => ({ userID: stored.identifier, password: stored.password }),
    toStored: (key, value) => storedPasswordCredential(key, value.userID, value.password),
  };
}

function emailInput(
  credentials: EmailPasswordCredentials,
): CredentialInput<"moneyforward", EmailPasswordCredentials> {
  return {
    readEnvironment: () => Promise.resolve(undefined),
    prompt: () => Promise.resolve(credentials),
    fromStored: (stored) => ({ email: stored.identifier, password: stored.password }),
    toStored: (key, value) => storedPasswordCredential(key, value.email, value.password),
  };
}
