import type { ConnectionID } from "./connection.ts";

export type AssetID = string;

export interface Asset {
  readonly id: AssetID;
  readonly connectionID: ConnectionID;
  readonly name: string;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Providerが表示する取得時点の現在資産。
 *
 * 取引の所属先であるWalletとは別概念として扱う。
 */
export interface AssetBalance {
  readonly asset: Asset;
  readonly amount: number;
  readonly observedAt: Date;
}
