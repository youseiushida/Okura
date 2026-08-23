import type { Fetcher } from "../../http/session.ts";
import type { ProviderConnection } from "../../model/connection.ts";
import type {
  AssetBalanceSource,
  CashInSource,
  CashOutSource,
  TransferSource,
} from "../../port/source.ts";
import type { ProviderModule } from "../../provider/module.ts";
import { MoneyForwardAdapter } from "./adapter.ts";
import { MoneyForwardAuthentication } from "./authentication.ts";
import { createMoneyForwardContext, MONEYFORWARD_PROVIDER_ID } from "./context.ts";
import type { Credentials } from "./login.ts";

export interface Config {
  readonly connection: ProviderConnection<typeof MONEYFORWARD_PROVIDER_ID>;
  readonly baseURL?: string;
  readonly idBaseURL?: string;
  readonly fetch?: Fetcher;
  readonly now?: () => Date;
}

export type MoneyForwardModule = ProviderModule<
  typeof MONEYFORWARD_PROVIDER_ID,
  Credentials,
  {
    readonly assetBalances: AssetBalanceSource;
    readonly cashIns: CashInSource;
    readonly cashOuts: CashOutSource;
    readonly transfers: TransferSource;
  }
>;

export function createMoneyForwardModule(config: Config): MoneyForwardModule {
  const context = createMoneyForwardContext(config);
  const source = new MoneyForwardAdapter(context, { now: config.now });
  return {
    connection: config.connection,
    auth: new MoneyForwardAuthentication(context),
    sources: {
      assetBalances: source,
      cashIns: source,
      cashOuts: source,
      transfers: source,
    },
  };
}
