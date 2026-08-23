import type { CashOutFetchUseCase } from "../application/fetch.ts";
import type { CredentialInput } from "../application/credentials.ts";
import {
  type FetchArguments,
  parseAmazonFetchArguments,
  parseJCBFetchArguments,
  parseMoneyForwardFetchArguments,
  type SupportedProviderID,
} from "./arguments.ts";
import {
  amazonCredentialInput,
  jcbCredentialInput,
  moneyForwardCredentialInput,
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
    jcbCredentialInput(environment),
    environment,
  );
}

async function runAmazonFetch(args: string[], environment: CLIEnvironment): Promise<number> {
  const options = parseAmazonFetchArguments(args);
  return await runCashOutFetch(
    environment.createAmazonFetch(options.connection, options.walletID),
    options,
    amazonCredentialInput(environment),
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
    saveCredentials: options.saveCredentials,
    interaction: createAuthInteraction(environment),
    credentialInput: moneyForwardCredentialInput(environment),
  });

  reportAuthentication(result.authentication, result.connection, environment);
  environment.write(presentFinancialSnapshot(result, options));
  return 0;
}

async function runCashOutFetch<Credentials, Provider extends SupportedProviderID>(
  useCase: CashOutFetchUseCase<Credentials, Provider>,
  options: Pick<
    FetchArguments,
    "period" | "periodLabels" | "format" | "reauthenticate" | "saveCredentials"
  >,
  credentialInput: CredentialInput<Provider, Credentials>,
  environment: CLIEnvironment,
): Promise<number> {
  const result = await useCase.execute({
    period: options.period,
    forceReauthentication: options.reauthenticate,
    saveCredentials: options.saveCredentials,
    interaction: createAuthInteraction(environment),
    credentialInput,
  });

  reportAuthentication(result.authentication, result.connection, environment);
  environment.write(presentCashOuts(result, options));
  return 0;
}
