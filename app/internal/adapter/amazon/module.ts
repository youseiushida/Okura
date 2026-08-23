import type { Fetcher } from "../../http/session.ts";
import type { ProviderConnection } from "../../model/connection.ts";
import { createWallet } from "../../model/account.ts";
import type { WalletID } from "../../model/account.ts";
import type { CashOutSource } from "../../port/source.ts";
import type { ProviderModule } from "../../provider/module.ts";
import { AmazonAdapter } from "./adapter.ts";
import { AmazonAuthentication } from "./authentication.ts";
import { AMAZON_PROVIDER_ID, createAmazonContext } from "./context.ts";
import type { Credentials } from "./login.ts";

export interface Config {
  readonly connection: ProviderConnection<typeof AMAZON_PROVIDER_ID>;
  readonly walletID: WalletID;
  readonly baseURL?: string;
  readonly fetch?: Fetcher;
  readonly pageDelayMs?: number;
}

export type AmazonModule = ProviderModule<
  typeof AMAZON_PROVIDER_ID,
  Credentials,
  { readonly cashOuts: CashOutSource }
>;

export function createAmazonModule(config: Config): AmazonModule {
  const context = createAmazonContext(config);
  const wallet = createWallet(
    config.connection,
    config.walletID,
    config.walletID,
    { source: AMAZON_PROVIDER_ID, local_id: config.walletID },
  );
  return {
    connection: config.connection,
    auth: new AmazonAuthentication(context),
    sources: {
      cashOuts: new AmazonAdapter(context, {
        wallet,
        pageDelayMs: config.pageDelayMs,
      }),
    },
  };
}
