import type { Fetcher } from "../../http/session.ts";
import { createWallet, type WalletID } from "../../model/account.ts";
import type { ProviderConnection } from "../../model/connection.ts";
import type { AuthenticationPort } from "../../port/authentication.ts";
import type { CashOutSource } from "../../port/source.ts";
import type { TurnstileSolverPort } from "../../port/turnstile_solver.ts";
import { YuchoDebitAdapter } from "./adapter.ts";
import { YuchoDebitAuthentication } from "./authentication.ts";
import { createYuchoDebitContext, YUCHO_DEBIT_PROVIDER_ID } from "./context.ts";
import type { Credentials } from "./login.ts";

export interface Config {
  readonly connection: ProviderConnection<typeof YUCHO_DEBIT_PROVIDER_ID>;
  readonly walletID: WalletID;
  readonly solver: TurnstileSolverPort;
  readonly baseURL?: string;
  readonly fetch?: Fetcher;
}

export interface YuchoDebitModule {
  readonly auth: AuthenticationPort<typeof YUCHO_DEBIT_PROVIDER_ID, Credentials>;
  readonly sources: {
    readonly cashOuts: CashOutSource;
  };
}

export function createYuchoDebitModule(config: Config): YuchoDebitModule {
  const context = createYuchoDebitContext({
    connection: config.connection,
    baseURL: config.baseURL,
    fetch: config.fetch,
  });
  const wallet = createWallet(
    config.connection,
    config.walletID,
    config.walletID,
    { source: YUCHO_DEBIT_PROVIDER_ID, local_id: config.walletID },
  );
  return {
    auth: new YuchoDebitAuthentication(context, { solver: config.solver }),
    sources: { cashOuts: new YuchoDebitAdapter(context, { wallet }) },
  };
}
