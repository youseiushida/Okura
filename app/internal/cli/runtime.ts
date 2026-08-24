import type { CashOutFetchUseCase, FinancialSnapshotFetchUseCase } from "../application/fetch.ts";
import type { ExternalServiceSecretConfigurationUseCase } from "../application/external_service_secret.ts";
import type { ProviderConnection } from "../model/connection.ts";
import type { EmailPasswordCredentials, UserIDPasswordCredentials } from "../port/credentials.ts";
import type { SessionVaultPort } from "../port/session_vault.ts";
import type { CredentialVaultPort } from "../port/credential_vault.ts";

export interface CLIIO {
  getEnv(name: string): string | undefined;
  askText(message: string): Promise<string>;
  askSecret(message: string): Promise<string>;
  write(message: string): void;
  warn(message: string): void;
}

export interface CLIEnvironment extends CLIIO {
  createSessionVault(): SessionVaultPort;
  createCredentialVault(): CredentialVaultPort;
  createTwoCaptchaApiKeyConfiguration(): ExternalServiceSecretConfigurationUseCase;
  createJCBFetch(
    connection: ProviderConnection<"jcb">,
    walletID: string,
  ): CashOutFetchUseCase<UserIDPasswordCredentials, "jcb">;
  createAmazonFetch(
    connection: ProviderConnection<"amazon">,
    walletID: string,
  ): CashOutFetchUseCase<EmailPasswordCredentials, "amazon">;
  createYuchoDebitFetch(
    connection: ProviderConnection<"yucho-debit">,
    walletID: string,
  ): CashOutFetchUseCase<UserIDPasswordCredentials, "yucho-debit">;
  createMoneyForwardFetch(
    connection: ProviderConnection<"moneyforward">,
  ): FinancialSnapshotFetchUseCase<EmailPasswordCredentials, "moneyforward">;
}
