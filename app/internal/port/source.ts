import type { CashIn, CashOut, Transfer } from "../model/transaction.ts";

export interface Period {
  from: Date;
  to: Date;
}

export interface FetchOptions {
  signal?: AbortSignal;
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
