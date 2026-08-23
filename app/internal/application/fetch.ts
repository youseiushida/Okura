import { AuthCoordinator, type EnsureAuthenticationResult } from "./authentication.ts";
import type { ProviderConnection } from "../model/connection.ts";
import type { AssetBalance } from "../model/asset.ts";
import type { CashIn, CashOut, Transfer } from "../model/transaction.ts";
import type { AuthInteraction } from "../port/auth_interaction.ts";
import type { AuthenticationOptions, AuthenticationPort } from "../port/authentication.ts";
import type { ProviderID } from "../port/provider.ts";
import type { SessionVaultPort } from "../port/session_vault.ts";
import type {
  AssetBalanceSource,
  CashInSource,
  CashOutSource,
  Period,
  TransferSource,
} from "../port/source.ts";

export interface FetchRequest<Credentials> {
  readonly period: Period;
  readonly forceReauthentication?: boolean;
  readonly interaction: AuthInteraction;
  readonly getCredentials: (
    options?: AuthenticationOptions,
  ) => Promise<Credentials>;
  readonly signal?: AbortSignal;
}

export interface CashOutFetchResult<Provider extends ProviderID = ProviderID> {
  readonly connection: ProviderConnection<Provider>;
  readonly authentication: EnsureAuthenticationResult;
  readonly cashOuts: CashOut[];
}

export interface FinancialSnapshot {
  readonly assetBalances: AssetBalance[];
  readonly cashIns: CashIn[];
  readonly cashOuts: CashOut[];
  readonly transfers: Transfer[];
}

export interface FinancialSnapshotFetchResult<Provider extends ProviderID = ProviderID>
  extends FinancialSnapshot {
  readonly connection: ProviderConnection<Provider>;
  readonly authentication: EnsureAuthenticationResult;
}

export interface CashOutFetchUseCase<
  Credentials,
  Provider extends ProviderID = ProviderID,
> {
  execute(request: FetchRequest<Credentials>): Promise<CashOutFetchResult<Provider>>;
}

export interface FinancialSnapshotFetchUseCase<
  Credentials,
  Provider extends ProviderID = ProviderID,
> {
  execute(request: FetchRequest<Credentials>): Promise<FinancialSnapshotFetchResult<Provider>>;
}

interface AuthenticatedDependencies<Provider extends ProviderID, Credentials> {
  readonly authentication: AuthenticationPort<Provider, Credentials>;
  readonly sessionVault: SessionVaultPort;
}

interface CashOutDependencies<Provider extends ProviderID, Credentials>
  extends AuthenticatedDependencies<Provider, Credentials> {
  readonly cashOuts: CashOutSource;
}

interface FinancialSnapshotDependencies<Provider extends ProviderID, Credentials>
  extends AuthenticatedDependencies<Provider, Credentials> {
  readonly assetBalances: AssetBalanceSource;
  readonly cashIns: CashInSource;
  readonly cashOuts: CashOutSource;
  readonly transfers: TransferSource;
}

export class FetchCashOuts<Provider extends ProviderID, Credentials>
  implements CashOutFetchUseCase<Credentials, Provider> {
  readonly #dependencies: CashOutDependencies<Provider, Credentials>;

  constructor(dependencies: CashOutDependencies<Provider, Credentials>) {
    this.#dependencies = dependencies;
  }

  async execute(request: FetchRequest<Credentials>): Promise<CashOutFetchResult<Provider>> {
    const authentication = await authenticate(this.#dependencies, request);
    const cashOuts = await this.#dependencies.cashOuts.fetchCashOuts(request.period, {
      signal: request.signal,
    });
    assertCashOutConnections(cashOuts, this.#dependencies.authentication.connection.id);

    return {
      connection: this.#dependencies.authentication.connection,
      authentication,
      cashOuts,
    };
  }
}

export class FetchFinancialSnapshot<Provider extends ProviderID, Credentials>
  implements FinancialSnapshotFetchUseCase<Credentials, Provider> {
  readonly #dependencies: FinancialSnapshotDependencies<Provider, Credentials>;

  constructor(dependencies: FinancialSnapshotDependencies<Provider, Credentials>) {
    this.#dependencies = dependencies;
  }

  async execute(
    request: FetchRequest<Credentials>,
  ): Promise<FinancialSnapshotFetchResult<Provider>> {
    const authentication = await authenticate(this.#dependencies, request);
    const snapshot = await fetchFinancialSnapshot(this.#dependencies, request);
    assertFinancialSnapshotConnections(
      snapshot,
      this.#dependencies.authentication.connection.id,
    );

    return {
      connection: this.#dependencies.authentication.connection,
      authentication,
      ...snapshot,
    };
  }
}

async function authenticate<Provider extends ProviderID, Credentials>(
  dependencies: AuthenticatedDependencies<Provider, Credentials>,
  request: FetchRequest<Credentials>,
): Promise<EnsureAuthenticationResult> {
  return await new AuthCoordinator(
    dependencies.authentication,
    dependencies.sessionVault,
  ).ensureAuthenticated({
    key: dependencies.authentication.connection,
    interaction: request.interaction,
    getCredentials: request.getCredentials,
    forceReauthentication: request.forceReauthentication,
    signal: request.signal,
  });
}

async function fetchFinancialSnapshot<Provider extends ProviderID, Credentials>(
  dependencies: FinancialSnapshotDependencies<Provider, Credentials>,
  request: FetchRequest<Credentials>,
): Promise<FinancialSnapshot> {
  const options = { signal: request.signal };
  const [assetBalances, cashIns, cashOuts, transfers] = await Promise.all([
    dependencies.assetBalances.fetchAssetBalances(options),
    dependencies.cashIns.fetchCashIns(request.period, options),
    dependencies.cashOuts.fetchCashOuts(request.period, options),
    dependencies.transfers.fetchTransfers(request.period, options),
  ]);
  return { assetBalances, cashIns, cashOuts, transfers };
}

function assertCashOutConnections(cashOuts: CashOut[], connectionID: string): void {
  for (const cashOut of cashOuts) {
    if (
      cashOut.connectionID !== connectionID || cashOut.from.connectionID !== connectionID
    ) {
      throw new TypeError("cash-out belongs to another connection");
    }
  }
}

function assertFinancialSnapshotConnections(
  snapshot: FinancialSnapshot,
  connectionID: string,
): void {
  for (const balance of snapshot.assetBalances) {
    if (balance.asset.connectionID !== connectionID) {
      throw new TypeError("asset balance belongs to another connection");
    }
  }
  for (const cashIn of snapshot.cashIns) {
    if (cashIn.connectionID !== connectionID || cashIn.to.connectionID !== connectionID) {
      throw new TypeError("cash-in belongs to another connection");
    }
  }
  assertCashOutConnections(snapshot.cashOuts, connectionID);
  for (const transfer of snapshot.transfers) {
    if (
      transfer.connectionID !== connectionID ||
      transfer.from.connectionID !== connectionID ||
      transfer.to.connectionID !== connectionID
    ) {
      throw new TypeError("transfer belongs to another connection");
    }
  }
}
