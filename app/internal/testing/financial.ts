import { createWallet } from "../model/account.ts";
import type { AssetBalance } from "../model/asset.ts";
import { createProviderConnection } from "../model/connection.ts";
import type { CashIn, CashOut, Transfer } from "../model/transaction.ts";

export function jcbCashOut(profile = "default"): CashOut {
  const connection = createProviderConnection("jcb", profile);
  return {
    id: `${connection.id}:transaction:${"a".repeat(64)}`,
    connectionID: connection.id,
    amount: 908,
    occurredAt: new Date("2026-06-17T15:00:00.000Z"),
    from: createWallet(connection, "wallet-jcb", "wallet-jcb"),
    to: { name: "ＣＬＯＵＤＦＬＡＲＥ", metadata: { source: "jcb" } },
  };
}

export function jcbCashIn(profile = "default"): CashIn {
  const connection = createProviderConnection("jcb", profile);
  return {
    id: `${connection.id}:transaction:${"b".repeat(64)}`,
    connectionID: connection.id,
    amount: 500,
    occurredAt: new Date("2026-06-18T15:00:00.000Z"),
    from: { name: "RETURNED STORE", metadata: { source: "jcb" } },
    to: createWallet(connection, "wallet-jcb", "wallet-jcb"),
  };
}

export function amazonCashOut(profile = "default"): CashOut {
  const connection = createProviderConnection("amazon", profile);
  return {
    id: `${connection.id}:transaction:123-4567890-1234567`,
    connectionID: connection.id,
    amount: 1280,
    occurredAt: new Date("2026-08-19T15:00:00.000Z"),
    from: createWallet(connection, "amazon", "amazon"),
    to: { name: "Amazon.co.jp", metadata: { source: "amazon" } },
  };
}

export function moneyForwardAssetBalance(profile = "default"): AssetBalance {
  const connection = createProviderConnection("moneyforward", profile);
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

export function moneyForwardCashIn(profile = "default"): CashIn {
  const connection = createProviderConnection("moneyforward", profile);
  return {
    id: `${connection.id}:transaction:user_asset_act:income`,
    connectionID: connection.id,
    amount: 2_000,
    occurredAt: new Date("2026-08-19T15:00:00.000Z"),
    from: { name: "返金", metadata: { source: "moneyforward" } },
    to: createWallet(connection, "yucho", "ゆうちょ", { source: "moneyforward" }),
  };
}

export function moneyForwardCashOut(profile = "default"): CashOut {
  const connection = createProviderConnection("moneyforward", profile);
  return {
    id: `${connection.id}:transaction:user_asset_act:expense`,
    connectionID: connection.id,
    amount: 800,
    occurredAt: new Date("2026-08-20T15:00:00.000Z"),
    from: createWallet(connection, "cash", "財布・現金", { source: "moneyforward" }),
    to: { name: "食料品店", metadata: { source: "moneyforward" } },
  };
}

export function moneyForwardTransfer(profile = "default"): Transfer {
  const connection = createProviderConnection("moneyforward", profile);
  return {
    id: `${connection.id}:transaction:user_asset_act:transfer`,
    connectionID: connection.id,
    amount: 5_000,
    occurredAt: new Date("2026-08-21T15:00:00.000Z"),
    from: createWallet(connection, "seven", "セブン銀行", { source: "moneyforward" }),
    to: createWallet(connection, "yucho", "ゆうちょ銀行", { source: "moneyforward" }),
  };
}
