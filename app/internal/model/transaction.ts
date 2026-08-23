import type { Wallet } from "./account.ts";
import type { ConnectionID } from "./connection.ts";

export interface ExternalParty {
  name: string;
  metadata: Readonly<Record<string, string>>;
}

export interface CashIn {
  readonly id: string;
  readonly connectionID: ConnectionID;
  readonly amount: number;
  readonly occurredAt: Date;
  readonly from: ExternalParty;
  readonly to: Wallet;
}

export interface CashOut {
  readonly id: string;
  readonly connectionID: ConnectionID;
  readonly amount: number;
  readonly occurredAt: Date;
  readonly from: Wallet;
  readonly to: ExternalParty;
}

export interface Transfer {
  readonly id: string;
  readonly connectionID: ConnectionID;
  readonly amount: number;
  readonly occurredAt: Date;
  readonly from: Wallet;
  readonly to: Wallet;
}
