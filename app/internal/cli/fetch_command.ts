import type { CashOutFetchUseCase } from "../application/fetch.ts";
import {
  type FetchArguments,
  parseAmazonFetchArguments,
  parseJCBFetchArguments,
  parseMoneyForwardFetchArguments,
  type SupportedProviderID,
} from "./arguments.ts";
import {
  readAmazonCredentials,
  readJCBCredentials,
  readMoneyForwardCredentials,
} from "./credentials.ts";
import { createAuthInteraction, reportAuthentication } from "./interaction.ts";
import { presentCashOuts, presentFinancialSnapshot } from "./presenter.ts";
import type { CLIEnvironment } from "./runtime.ts";

type FetchCommand = (args: string[], environment: CLIEnvironment) => Promise<number>;

const fetchCommands: Record<SupportedProviderID, FetchCommand> = {
  jcb: runJCBFetch,
  amazon: runAmazonFetch,
  moneyforward: runMoneyForwardFetch,
};

export function runFetchCommand(
  provider: SupportedProviderID,
  args: string[],
  environment: CLIEnvironment,
): Promise<number> {
  return fetchCommands[provider](args, environment);
}

async function runJCBFetch(args: string[], environment: CLIEnvironment): Promise<number> {
  const options = parseJCBFetchArguments(args);
  return await runCashOutFetch(
    environment.createJCBFetch(options.connection, options.walletID),
    options,
    () => readJCBCredentials(environment),
    environment,
  );
}

async function runAmazonFetch(args: string[], environment: CLIEnvironment): Promise<number> {
  const options = parseAmazonFetchArguments(args);
  return await runCashOutFetch(
    environment.createAmazonFetch(options.connection, options.walletID),
    options,
    () => readAmazonCredentials(environment),
    environment,
  );
}

async function runMoneyForwardFetch(
  args: string[],
  environment: CLIEnvironment,
): Promise<number> {
  const options = parseMoneyForwardFetchArguments(args);
  const result = await environment.createMoneyForwardFetch(options.connection).execute({
    period: options.period,
    forceReauthentication: options.reauthenticate,
    interaction: createAuthInteraction(environment),
    getCredentials: () => readMoneyForwardCredentials(environment),
  });

  reportAuthentication(result.authentication, result.connection, environment);
  environment.write(presentFinancialSnapshot(result, options));
  return 0;
}

async function runCashOutFetch<Credentials>(
  useCase: CashOutFetchUseCase<Credentials>,
  options: Pick<FetchArguments, "period" | "periodLabels" | "format" | "reauthenticate">,
  getCredentials: () => Promise<Credentials>,
  environment: CLIEnvironment,
): Promise<number> {
  const result = await useCase.execute({
    period: options.period,
    forceReauthentication: options.reauthenticate,
    interaction: createAuthInteraction(environment),
    getCredentials,
  });

  reportAuthentication(result.authentication, result.connection, environment);
  environment.write(presentCashOuts(result, options));
  return 0;
}
