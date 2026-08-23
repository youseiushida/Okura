import { type ConnectionID, type ProviderConnection, scopedID } from "./connection.ts";

export type WalletID = string;

export interface Wallet {
  readonly id: WalletID;
  readonly connectionID: ConnectionID;
  readonly name: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export function createWallet(
  connection: ProviderConnection,
  localID: string,
  name: string,
  metadata: Readonly<Record<string, string>> = {},
): Wallet {
  const normalizedName = name.trim();
  if (normalizedName === "") throw new TypeError("wallet name is required");
  return {
    id: scopedID(connection.id, "wallet", encodeURIComponent(localID)),
    connectionID: connection.id,
    name: normalizedName,
    metadata,
  };
}
