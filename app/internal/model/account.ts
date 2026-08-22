export type WalletID = string;

export interface Wallet {
  id: WalletID;
  name: string;
  metadata: Readonly<Record<string, string>>;
}
