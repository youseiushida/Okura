import type { Fetcher } from "../../http/session.ts";
import type { WalletID } from "../../model/account.ts";
import type { CashOutSource } from "../../port/source.ts";
import type { ProviderModule } from "../../provider/module.ts";
import { AmazonAdapter } from "./adapter.ts";
import { AmazonAuthentication } from "./authentication.ts";
import { AMAZON_PROVIDER_ID, createAmazonContext } from "./context.ts";
import type { Credentials } from "./login.ts";

export interface Config {
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
  return {
    auth: new AmazonAuthentication(context),
    sources: {
      cashOuts: new AmazonAdapter(context, {
        walletID: config.walletID,
        pageDelayMs: config.pageDelayMs,
      }),
    },
  };
}
