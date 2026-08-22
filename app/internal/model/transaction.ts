import type { WalletID } from "./account.ts";

export interface ExternalParty {
  name: string;
  metadata: Readonly<Record<string, string>>;
}

export interface CashIn {
  id: string;
  amount: number;
  occurredAt: Date;
  from: ExternalParty;
  to: WalletID;
}

export interface CashOut {
  id: string;
  amount: number;
  occurredAt: Date;
  from: WalletID;
  to: ExternalParty;
}

export interface Transfer {
  id: string;
  amount: number;
  occurredAt: Date;
  from: WalletID;
  to: WalletID;
}
