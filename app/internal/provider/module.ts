import type { AuthenticationPort } from "../port/authentication.ts";
import type { ProviderID } from "../port/provider.ts";
import type { CashInSource, CashOutSource, TransferSource } from "../port/source.ts";

export interface ProviderSources {
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
  Credentials,
  Sources extends ProviderSources,
> {
  readonly id: ProviderID;
  readonly auth: AuthenticationPort<Credentials>;
  readonly sources: Sources;
}
