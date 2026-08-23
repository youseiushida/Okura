import { createJCBModule } from "../adapter/jcb/mod.ts";
import type { Credentials, JCBModule } from "../adapter/jcb/mod.ts";
import { createAmazonModule } from "../adapter/amazon/mod.ts";
import type { AmazonModule, Credentials as AmazonCredentials } from "../adapter/amazon/mod.ts";
import { createDefaultSessionVault } from "../adapter/session/dpapi_vault.ts";
import { createMoneyForwardModule } from "../adapter/moneyforward/mod.ts";
import type {
  Credentials as MoneyForwardCredentials,
  MoneyForwardModule,
} from "../adapter/moneyforward/mod.ts";
import { AuthCoordinator, type EnsureAuthenticationResult } from "../auth/coordinator.ts";
import { createProviderConnection, type ProviderConnection } from "../model/connection.ts";
import type { Wallet } from "../model/account.ts";
import type { AssetBalance } from "../model/asset.ts";
import type { CashIn, CashOut, Transfer } from "../model/transaction.ts";
import type { AuthInteraction } from "../port/auth_interaction.ts";
import type { SessionVaultPort } from "../port/session_vault.ts";
import type { Period } from "../port/source.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const SUPPORTED_PROVIDER_IDS = ["jcb", "amazon", "moneyforward"] as const;
type SupportedProviderID = (typeof SUPPORTED_PROVIDER_IDS)[number];

export interface CLIEnvironment {
  getEnv(name: string): string | undefined;
  askText(message: string): Promise<string>;
  askSecret(message: string): Promise<string>;
  write(message: string): void;
  warn(message: string): void;
  createSessionVault(): SessionVaultPort;
  createJCB(connection: ProviderConnection<"jcb">, walletID: string): JCBModule;
  createAmazon(connection: ProviderConnection<"amazon">, walletID: string): AmazonModule;
  createMoneyForward(connection: ProviderConnection<"moneyforward">): MoneyForwardModule;
}

export interface JCBFetchArguments<Provider extends string = string> {
  walletID: string;
  profile: string;
  connection: ProviderConnection<Provider>;
  reauthenticate: boolean;
  fromLabel: string;
  toLabel: string;
  period: Period;
  format: "table" | "json";
}

const defaultEnvironment: CLIEnvironment = {
  getEnv: (name) => Deno.env.get(name),
  askText: (message) => Promise.resolve(globalThis.prompt(message) ?? ""),
  askSecret: readHiddenLine,
  write: (message) => console.log(message),
  warn: (message) => console.warn(message),
  createSessionVault: createDefaultSessionVault,
  createJCB: (connection, walletID) => createJCBModule({ connection, walletID }),
  createAmazon: (connection, walletID) => createAmazonModule({ connection, walletID }),
  createMoneyForward: (connection) => createMoneyForwardModule({ connection }),
};

export async function runCLI(
  rawArguments: string[],
  environment: CLIEnvironment = defaultEnvironment,
): Promise<number> {
  const args = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    environment.write(usage());
    return 0;
  }
  if (!(SUPPORTED_PROVIDER_IDS as readonly string[]).includes(args[0] ?? "")) {
    throw new TypeError(`unknown command\n\n${usage()}`);
  }
  const provider = args[0] as SupportedProviderID;
  if (args[1] === "session" && args[2] === "remove") {
    return await runSessionRemove(provider, args.slice(3), environment);
  }
  if (args[1] !== "fetch") throw new TypeError(`unknown command\n\n${usage()}`);

  if (provider === "jcb") return await runJCBFetch(args.slice(2), environment);
  if (provider === "amazon") return await runAmazonFetch(args.slice(2), environment);
  return await runMoneyForwardFetch(args.slice(2), environment);
}

async function runSessionRemove(
  provider: SupportedProviderID,
  args: string[],
  environment: CLIEnvironment,
): Promise<number> {
  const connection = parseSessionConnection(provider, args);
  await environment.createSessionVault().remove(connection);
  environment.write(`Removed saved session for connection ${connection.id}.`);
  return 0;
}

async function runJCBFetch(args: string[], environment: CLIEnvironment): Promise<number> {
  const options = parseJCBFetchArguments(args);
  const module = environment.createJCB(options.connection, options.walletID);
  const result = await new AuthCoordinator(module.auth, environment.createSessionVault())
    .ensureAuthenticated({
      key: options.connection,
      forceReauthentication: options.reauthenticate,
      interaction: createAuthInteraction(environment),
      getCredentials: async (): Promise<Credentials> => {
        const userID = environment.getEnv("JCB_USER_ID")?.trim() ||
          (await environment.askText("MyJCB user ID:")).trim();
        const password = environment.getEnv("JCB_PASSWORD") ||
          await environment.askSecret("MyJCB password: ");
        if (userID === "") throw new TypeError("MyJCB user ID is required");
        if (password === "") throw new TypeError("MyJCB password is required");
        return { userID, password };
      },
    });
  reportAuthenticationResult(result, options.connection, environment);
  const cashOuts = await module.sources.cashOuts.fetchCashOuts(options.period);
  environment.write(formatCashOuts(cashOuts, options));
  return 0;
}

async function runAmazonFetch(args: string[], environment: CLIEnvironment): Promise<number> {
  const options = parseAmazonFetchArguments(args);
  const module = environment.createAmazon(options.connection, options.walletID);
  const result = await new AuthCoordinator(module.auth, environment.createSessionVault())
    .ensureAuthenticated({
      key: options.connection,
      forceReauthentication: options.reauthenticate,
      interaction: createAuthInteraction(environment),
      getCredentials: async (): Promise<AmazonCredentials> => {
        const email = normalizeAmazonEmail(
          environment.getEnv("AMAZON_EMAIL")?.trim() ||
            (await environment.askText("Amazon email: ")).trim(),
        );
        const password = environment.getEnv("AMAZON_PASSWORD") ||
          await environment.askSecret("Amazon password: ");
        if (email === "") throw new TypeError("Amazon email is required");
        if (password === "") throw new TypeError("Amazon password is required");
        return { email, password };
      },
    });
  reportAuthenticationResult(result, options.connection, environment);
  const cashOuts = await module.sources.cashOuts.fetchCashOuts(options.period);
  environment.write(formatCashOuts(cashOuts, options));
  return 0;
}

async function runMoneyForwardFetch(
  args: string[],
  environment: CLIEnvironment,
): Promise<number> {
  const options = parseMoneyForwardFetchArguments(args);
  const module = environment.createMoneyForward(options.connection);
  const result = await new AuthCoordinator(module.auth, environment.createSessionVault())
    .ensureAuthenticated({
      key: options.connection,
      forceReauthentication: options.reauthenticate,
      interaction: createAuthInteraction(environment),
      getCredentials: async (): Promise<MoneyForwardCredentials> => {
        const email = normalizeEmail(
          environment.getEnv("MONEYFORWARD_EMAIL")?.trim() ||
            (await environment.askText("Money Forward email: ")).trim(),
        );
        const password = environment.getEnv("MONEYFORWARD_PASSWORD") ||
          await environment.askSecret("Money Forward password: ");
        if (email === "") throw new TypeError("Money Forward email is required");
        if (password === "") throw new TypeError("Money Forward password is required");
        return { email, password };
      },
    });
  reportAuthenticationResult(result, options.connection, environment);
  const [assetBalances, cashIns, cashOuts, transfers] = await Promise.all([
    module.sources.assetBalances.fetchAssetBalances(),
    module.sources.cashIns.fetchCashIns(options.period),
    module.sources.cashOuts.fetchCashOuts(options.period),
    module.sources.transfers.fetchTransfers(options.period),
  ]);
  environment.write(formatMoneyForward(assetBalances, cashIns, cashOuts, transfers, options));
  return 0;
}

export function parseJCBFetchArguments(args: string[]): JCBFetchArguments<"jcb"> {
  return parseFetchArguments(args, "jcb", "jcb");
}

export function parseAmazonFetchArguments(args: string[]): JCBFetchArguments<"amazon"> {
  return parseFetchArguments(args, "amazon", "amazon");
}

export function parseMoneyForwardFetchArguments(
  args: string[],
): JCBFetchArguments<"moneyforward"> {
  if (args.includes("--wallet-id")) {
    throw new TypeError("--wallet-id is not available for moneyforward; wallets are discovered");
  }
  return parseFetchArguments(args, "moneyforward", "moneyforward");
}

function parseFetchArguments<Provider extends SupportedProviderID>(
  args: string[],
  provider: Provider,
  defaultWalletID: string,
): JCBFetchArguments<Provider> {
  let walletID = defaultWalletID;
  let profile = "default";
  let fromLabel = "";
  let toLabel = "";
  let format: JCBFetchArguments["format"] = "table";
  let reauthenticate = false;

  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--") continue;
    if (name === "--reauth") {
      reauthenticate = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TypeError(`${name} requires a value`);
    }
    switch (name) {
      case "--wallet-id":
        walletID = value;
        break;
      case "--profile":
        profile = value;
        break;
      case "--from":
        fromLabel = value;
        break;
      case "--to":
        toLabel = value;
        break;
      case "--format":
        if (value !== "table" && value !== "json") {
          throw new TypeError("--format must be table or json");
        }
        format = value;
        break;
      default:
        throw new TypeError(`unknown option ${JSON.stringify(name)}`);
    }
    index += 1;
  }

  if (walletID.trim() === "") throw new TypeError("--wallet-id must not be empty");
  profile = profile.trim();
  if (profile === "") throw new TypeError("--profile must not be empty");
  if (fromLabel === "") throw new TypeError("--from is required");
  if (toLabel === "") throw new TypeError("--to is required");
  const from = parseJSTDate(fromLabel, "--from");
  const toInclusive = parseJSTDate(toLabel, "--to");
  if (from.getTime() > toInclusive.getTime()) {
    throw new TypeError("--from must not be after --to");
  }
  return {
    walletID,
    profile,
    connection: createProviderConnection(provider, profile),
    reauthenticate,
    fromLabel,
    toLabel,
    period: { from, to: new Date(toInclusive.getTime() + DAY_MS) },
    format,
  };
}

function parseSessionConnection<Provider extends SupportedProviderID>(
  provider: Provider,
  args: string[],
): ProviderConnection<Provider> {
  let profile = "default";
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--") continue;
    if (name !== "--profile") throw new TypeError(`unknown option ${JSON.stringify(name)}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TypeError("--profile requires a value");
    }
    profile = value;
    index += 1;
  }
  return createProviderConnection(provider, profile);
}

function createAuthInteraction(environment: CLIEnvironment): AuthInteraction {
  return {
    otp: {
      request: async (challenge) => ({
        action: "submit",
        code: await environment.askText(
          `${challenge.provider} verification code (${challenge.channel}): `,
        ),
      }),
    },
    progress: {
      publish: (event) => {
        if (event.kind === "external-approval" && event.state === "required") {
          environment.warn(
            event.message ?? `${event.provider}: external approval is required (${event.method})`,
          );
        }
        return Promise.resolve();
      },
    },
  };
}

function reportAuthenticationResult(
  result: EnsureAuthenticationResult,
  connection: ProviderConnection,
  environment: CLIEnvironment,
): void {
  environment.warn(
    `Using connection ${connection.id} (${
      result.session === "reused" ? "saved session" : "new login"
    }).`,
  );
  if (result.recovery !== undefined) {
    environment.warn(
      `Saved ${result.recovery.reason} session was ${result.recovery.storedSnapshot}; logged in again.`,
    );
  }
  if (result.persistence.status === "failed") {
    environment.warn(
      `Authenticated, but the session could not be saved: ${
        errorMessage(result.persistence.error)
      }`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatCashOuts(cashOuts: CashOut[], options: JCBFetchArguments): string {
  assertCashOutConnections(cashOuts, options.connection.id);
  const totalAmount = cashOuts.reduce((total, cashOut) => total + cashOut.amount, 0);
  if (options.format === "json") {
    return JSON.stringify(
      {
        connection: options.connection,
        period: { from: options.fromLabel, to: options.toLabel },
        count: cashOuts.length,
        totalAmount,
        cashOuts: cashOuts.map((cashOut) => ({
          id: cashOut.id,
          date: formatJSTDate(cashOut.occurredAt),
          amount: cashOut.amount,
          connectionID: cashOut.connectionID,
          fromWallet: serializeWallet(cashOut.from),
          merchant: cashOut.to.name,
          metadata: cashOut.to.metadata,
        })),
      },
      null,
      2,
    );
  }

  const lines = [
    `期間: ${options.fromLabel} 〜 ${options.toLabel}`,
    `件数: ${cashOuts.length}件  合計: ${new Intl.NumberFormat("ja-JP").format(totalAmount)}円`,
    "",
    "日付\t金額\t利用先",
    ...cashOuts.map((cashOut) =>
      `${formatJSTDate(cashOut.occurredAt)}\t${cashOut.amount}円\t${cashOut.to.name}`
    ),
  ];
  return lines.join("\n");
}

export function formatMoneyForward(
  assetBalances: AssetBalance[],
  cashIns: CashIn[],
  cashOuts: CashOut[],
  transfers: Transfer[],
  options: JCBFetchArguments,
): string {
  assertMoneyForwardConnections(
    assetBalances,
    cashIns,
    cashOuts,
    transfers,
    options.connection.id,
  );
  const totalAssets = assetBalances.reduce((total, balance) => total + balance.amount, 0);
  const totalCashIns = cashIns.reduce((total, cashIn) => total + cashIn.amount, 0);
  const totalCashOuts = cashOuts.reduce((total, cashOut) => total + cashOut.amount, 0);
  const totalTransfers = transfers.reduce((total, transfer) => total + transfer.amount, 0);
  if (options.format === "json") {
    return JSON.stringify(
      {
        connection: options.connection,
        period: { from: options.fromLabel, to: options.toLabel },
        assets: {
          count: assetBalances.length,
          totalAmount: totalAssets,
          balances: assetBalances.map((balance) => ({
            id: balance.asset.id,
            connectionID: balance.asset.connectionID,
            name: balance.asset.name,
            amount: balance.amount,
            observedAt: balance.observedAt.toISOString(),
            metadata: balance.asset.metadata,
          })),
        },
        cashFlow: {
          cashInCount: cashIns.length,
          cashOutCount: cashOuts.length,
          transferCount: transfers.length,
          totalCashInAmount: totalCashIns,
          totalCashOutAmount: totalCashOuts,
          totalTransferAmount: totalTransfers,
          cashIns: cashIns.map((cashIn) => ({
            id: cashIn.id,
            connectionID: cashIn.connectionID,
            date: formatJSTDate(cashIn.occurredAt),
            amount: cashIn.amount,
            from: cashIn.from.name,
            toWallet: serializeWallet(cashIn.to),
            metadata: cashIn.from.metadata,
          })),
          cashOuts: cashOuts.map((cashOut) => ({
            id: cashOut.id,
            connectionID: cashOut.connectionID,
            date: formatJSTDate(cashOut.occurredAt),
            amount: cashOut.amount,
            fromWallet: serializeWallet(cashOut.from),
            to: cashOut.to.name,
            metadata: cashOut.to.metadata,
          })),
          transfers: transfers.map((transfer) => ({
            id: transfer.id,
            connectionID: transfer.connectionID,
            date: formatJSTDate(transfer.occurredAt),
            amount: transfer.amount,
            fromWallet: serializeWallet(transfer.from),
            toWallet: serializeWallet(transfer.to),
          })),
        },
      },
      null,
      2,
    );
  }

  return [
    "現在資産",
    `件数: ${assetBalances.length}件  合計: ${formatJPY(totalAssets)}`,
    "名称\t金額\t金融機関",
    ...assetBalances.map((balance) =>
      `${balance.asset.name}\t${formatJPY(balance.amount)}\t${
        balance.asset.metadata.institution ?? ""
      }`
    ),
    "",
    `キャッシュフロー: ${options.fromLabel} 〜 ${options.toLabel}`,
    `入金: ${cashIns.length}件 ${formatJPY(totalCashIns)}  出金: ${cashOuts.length}件 ${
      formatJPY(totalCashOuts)
    }  振替: ${transfers.length}件 ${formatJPY(totalTransfers)}`,
    "種別\t日付\t金額\t内容\tウォレット",
    ...cashIns.map((cashIn) =>
      `入金\t${formatJSTDate(cashIn.occurredAt)}\t${
        formatJPY(cashIn.amount)
      }\t${cashIn.from.name}\t${cashIn.to.name}`
    ),
    ...cashOuts.map((cashOut) =>
      `出金\t${formatJSTDate(cashOut.occurredAt)}\t${
        formatJPY(cashOut.amount)
      }\t${cashOut.to.name}\t${cashOut.from.name}`
    ),
    ...transfers.map((transfer) =>
      `振替\t${formatJSTDate(transfer.occurredAt)}\t${
        formatJPY(transfer.amount)
      }\t${transfer.from.name}\t${transfer.to.name}`
    ),
  ].join("\n");
}

function serializeWallet(wallet: Wallet): Wallet {
  return {
    id: wallet.id,
    connectionID: wallet.connectionID,
    name: wallet.name,
    metadata: wallet.metadata,
  };
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

function assertMoneyForwardConnections(
  assetBalances: AssetBalance[],
  cashIns: CashIn[],
  cashOuts: CashOut[],
  transfers: Transfer[],
  connectionID: string,
): void {
  for (const balance of assetBalances) {
    if (balance.asset.connectionID !== connectionID) {
      throw new TypeError("asset balance belongs to another connection");
    }
  }
  for (const cashIn of cashIns) {
    if (cashIn.connectionID !== connectionID || cashIn.to.connectionID !== connectionID) {
      throw new TypeError("cash-in belongs to another connection");
    }
  }
  assertCashOutConnections(cashOuts, connectionID);
  for (const transfer of transfers) {
    if (
      transfer.connectionID !== connectionID || transfer.from.connectionID !== connectionID ||
      transfer.to.connectionID !== connectionID
    ) {
      throw new TypeError("transfer belongs to another connection");
    }
  }
}

function formatJPY(value: number): string {
  return `${new Intl.NumberFormat("ja-JP").format(value)}円`;
}

function parseJSTDate(value: string, name: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match === null) throw new TypeError(`${name} must be YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = new Date(Date.UTC(year, month - 1, day) - JST_OFFSET_MS);
  if (formatJSTDate(result) !== value) throw new TypeError(`${name} is not a valid date`);
  return result;
}

function formatJSTDate(value: Date): string {
  return new Date(value.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function normalizeAmazonEmail(value: string): string {
  return normalizeEmail(value);
}

function normalizeEmail(value: string): string {
  return value.replaceAll("\\@", "@").replaceAll("＠", "@");
}

async function readHiddenLine(message: string): Promise<string> {
  if (!Deno.stdin.isTerminal()) {
    throw new Error("password is not set and stdin is not interactive");
  }
  await Deno.stdout.write(new TextEncoder().encode(message));
  const bytes: number[] = [];
  const buffer = new Uint8Array(1);
  Deno.stdin.setRaw(true);
  try {
    while (true) {
      const read = await Deno.stdin.read(buffer);
      if (read === null) break;
      const byte = buffer[0];
      if (byte === undefined) continue;
      if (byte === 3) throw new DOMException("Interrupted", "AbortError");
      if (byte === 13 || byte === 10) break;
      if (byte === 8 || byte === 127) {
        bytes.pop();
        continue;
      }
      bytes.push(byte);
    }
  } finally {
    Deno.stdin.setRaw(false);
    await Deno.stdout.write(new Uint8Array([13, 10]));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function usage(): string {
  return `Okura

Usage:
  okura.exe jcb fetch --from YYYY-MM-DD --to YYYY-MM-DD [options]
  okura.exe amazon fetch --from YYYY-MM-DD --to YYYY-MM-DD [options]
  okura.exe moneyforward fetch --from YYYY-MM-DD --to YYYY-MM-DD [options]
  okura.exe PROVIDER session remove [--profile NAME]

Development:
  deno task jcb -- --from YYYY-MM-DD --to YYYY-MM-DD [options]
  deno task amazon -- --from YYYY-MM-DD --to YYYY-MM-DD [options]
  deno task moneyforward -- --from YYYY-MM-DD --to YYYY-MM-DD [options]

Options:
  --wallet-id ID       Source wallet ID for JCB/Amazon (default: adapter name)
  --profile NAME       Saved login profile (default: default)
  --reauth             Remove the saved session and log in again
  --from DATE          First date to fetch (inclusive)
  --to DATE            Last date to fetch (inclusive)
  --format table|json  Output format (default: table)

Credentials:
  Enter interactively, or set JCB_USER_ID/JCB_PASSWORD or
  AMAZON_EMAIL/AMAZON_PASSWORD or
  MONEYFORWARD_EMAIL/MONEYFORWARD_PASSWORD.`;
}
