import type { CashIn, CashOut, Transfer } from "../model/transaction.ts";
import type { AssetBalance } from "../model/asset.ts";
import type { ProviderID } from "./provider.ts";

/** Sourceの呼び出し前、または取得中に認証切れが確定した。 */
export class AuthenticationRequiredError extends Error {
  readonly provider: ProviderID;

  constructor(provider: ProviderID, message = `${provider} authentication is required`) {
    super(message);
    this.name = "AuthenticationRequiredError";
    this.provider = provider;
  }
}

export interface Period {
  from: Date;
  to: Date;
}

export interface FetchOptions {
  signal?: AbortSignal;
}

export interface AssetBalanceSource {
  fetchAssetBalances(options?: FetchOptions): Promise<AssetBalance[]>;
}

export interface CashInSource {
  fetchCashIns(period: Period, options?: FetchOptions): Promise<CashIn[]>;
}

export interface CashOutSource {
  fetchCashOuts(period: Period, options?: FetchOptions): Promise<CashOut[]>;
}

export interface TransferSource {
  fetchTransfers(period: Period, options?: FetchOptions): Promise<Transfer[]>;
}
