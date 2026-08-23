import type { Fetcher } from "../../http/session.ts";
import type { ProviderConnection } from "../../model/connection.ts";
import { createWallet } from "../../model/account.ts";
import type { WalletID } from "../../model/account.ts";
import type { CashOutSource } from "../../port/source.ts";
import type { ProviderModule } from "../../provider/module.ts";
import { JCBAdapter } from "./adapter.ts";
import { JCBAuthentication } from "./authentication.ts";
import { createJCBContext, JCB_PROVIDER_ID } from "./context.ts";
import type { Credentials, LoginOptions } from "./login.ts";

export interface Config {
  readonly connection: ProviderConnection<typeof JCB_PROVIDER_ID>;
  readonly walletID: WalletID;
  readonly baseURL?: string;
  readonly fetch?: Fetcher;
  readonly now?: () => Date;
  readonly login?: Omit<LoginOptions, "signal">;
}

export type JCBModule = ProviderModule<
  typeof JCB_PROVIDER_ID,
  Credentials,
  { readonly cashOuts: CashOutSource }
>;

export function createJCBModule(config: Config): JCBModule {
  const context = createJCBContext(config);
  const wallet = createWallet(
    config.connection,
    config.walletID,
    config.walletID,
    { source: JCB_PROVIDER_ID, local_id: config.walletID },
  );
  return {
    connection: config.connection,
    auth: new JCBAuthentication(context, config.login),
    sources: {
      cashOuts: new JCBAdapter(context, {
        wallet,
        now: config.now,
      }),
    },
  };
}
