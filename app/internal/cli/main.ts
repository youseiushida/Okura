import { createJCBModule } from "../adapter/jcb/mod.ts";
import type { Credentials, JCBModule } from "../adapter/jcb/mod.ts";
import { createAmazonModule } from "../adapter/amazon/mod.ts";
import type { AmazonModule, Credentials as AmazonCredentials } from "../adapter/amazon/mod.ts";
import { createDefaultSessionVault } from "../adapter/session/dpapi_vault.ts";
import { AuthCoordinator, type EnsureAuthenticationResult } from "../auth/coordinator.ts";
import type { CashOut } from "../model/transaction.ts";
import type { AuthInteraction } from "../port/auth_interaction.ts";
import type { SessionVaultPort } from "../port/session_vault.ts";
import type { Period } from "../port/source.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const SUPPORTED_PROVIDER_IDS = ["jcb", "amazon"] as const;

export interface CLIEnvironment {
  getEnv(name: string): string | undefined;
  askText(message: string): Promise<string>;
  askSecret(message: string): Promise<string>;
  write(message: string): void;
  warn(message: string): void;
  createSessionVault(): SessionVaultPort;
  createJCB(walletID: string): JCBModule;
  createAmazon(walletID: string): AmazonModule;
}

export interface JCBFetchArguments {
  walletID: string;
  profile: string;
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
  createJCB: (walletID) => createJCBModule({ walletID }),
  createAmazon: (walletID) => createAmazonModule({ walletID }),
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
  if (
    args[1] !== "fetch" ||
    !(SUPPORTED_PROVIDER_IDS as readonly string[]).includes(args[0] ?? "")
  ) {
    throw new TypeError(`unknown command\n\n${usage()}`);
  }

  if (args[0] === "amazon") return await runAmazonFetch(args.slice(2), environment);
  return await runJCBFetch(args.slice(2), environment);
}

async function runJCBFetch(args: string[], environment: CLIEnvironment): Promise<number> {
  const options = parseJCBFetchArguments(args);
  const module = environment.createJCB(options.walletID);
  const result = await new AuthCoordinator(module.auth, environment.createSessionVault())
    .ensureAuthenticated({
      key: { provider: module.auth.provider, profile: options.profile },
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
  reportAuthenticationResult(result, environment);
  const cashOuts = await module.sources.cashOuts.fetchCashOuts(options.period);
  environment.write(formatCashOuts(cashOuts, options));
  return 0;
}

async function runAmazonFetch(args: string[], environment: CLIEnvironment): Promise<number> {
  const options = parseAmazonFetchArguments(args);
  const module = environment.createAmazon(options.walletID);
  const result = await new AuthCoordinator(module.auth, environment.createSessionVault())
    .ensureAuthenticated({
      key: { provider: module.auth.provider, profile: options.profile },
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
  reportAuthenticationResult(result, environment);
  const cashOuts = await module.sources.cashOuts.fetchCashOuts(options.period);
  environment.write(formatCashOuts(cashOuts, options));
  return 0;
}

export function parseJCBFetchArguments(args: string[]): JCBFetchArguments {
  return parseFetchArguments(args, "jcb");
}

export function parseAmazonFetchArguments(args: string[]): JCBFetchArguments {
  return parseFetchArguments(args, "amazon");
}

function parseFetchArguments(args: string[], defaultWalletID: string): JCBFetchArguments {
  let walletID = defaultWalletID;
  let profile = "default";
  let fromLabel = "";
  let toLabel = "";
  let format: JCBFetchArguments["format"] = "table";

  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--") continue;
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
  if (profile.trim() === "") throw new TypeError("--profile must not be empty");
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
    fromLabel,
    toLabel,
    period: { from, to: new Date(toInclusive.getTime() + DAY_MS) },
    format,
  };
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
  environment: CLIEnvironment,
): void {
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
  const totalAmount = cashOuts.reduce((total, cashOut) => total + cashOut.amount, 0);
  if (options.format === "json") {
    return JSON.stringify(
      {
        period: { from: options.fromLabel, to: options.toLabel },
        count: cashOuts.length,
        totalAmount,
        cashOuts: cashOuts.map((cashOut) => ({
          id: cashOut.id,
          date: formatJSTDate(cashOut.occurredAt),
          amount: cashOut.amount,
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

Development:
  deno task jcb -- --from YYYY-MM-DD --to YYYY-MM-DD [options]
  deno task amazon -- --from YYYY-MM-DD --to YYYY-MM-DD [options]

Options:
  --wallet-id ID       Wallet ID (default: adapter name)
  --profile NAME       Saved login profile (default: default)
  --from DATE          First date to fetch (inclusive)
  --to DATE            Last date to fetch (inclusive)
  --format table|json  Output format (default: table)

Credentials:
  Enter interactively, or set JCB_USER_ID/JCB_PASSWORD or
  AMAZON_EMAIL/AMAZON_PASSWORD.`;
}
