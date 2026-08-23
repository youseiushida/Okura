import type { AuthenticationPort } from "../port/authentication.ts";
import type { ProviderConnection } from "../model/connection.ts";
import type {
  AssetBalanceSource,
  CashInSource,
  CashOutSource,
  TransferSource,
} from "../port/source.ts";

export interface ProviderSources {
  readonly assetBalances?: AssetBalanceSource;
  readonly cashIns?: CashInSource;
  readonly cashOuts?: CashOutSource;
  readonly transfers?: TransferSource;
}

/**
 * factoryが返すprovider部品の集合。
 *
 * composition root以外のユースケースへ
 * この型全体を渡してはいけない。
 */
export interface ProviderModule<
  Provider extends string,
  Credentials,
  Sources extends ProviderSources,
> {
  readonly connection: ProviderConnection<Provider>;
  readonly auth: AuthenticationPort<Provider, Credentials>;
  readonly sources: Sources;
}
