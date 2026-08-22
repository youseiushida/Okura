import { JCBAdapter } from "../adapter/jcb/mod.ts";
import type { Credentials } from "../adapter/jcb/mod.ts";
import { AmazonAdapter } from "../adapter/amazon/mod.ts";
import type {
  Credentials as AmazonCredentials,
  LoginOptions as AmazonLoginOptions,
} from "../adapter/amazon/mod.ts";
import type { CashOut } from "../model/transaction.ts";
import type { Period } from "../port/source.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface JCBClient {
  login(credentials: Credentials): Promise<void>;
  fetchCashOuts(period: Period): Promise<CashOut[]>;
}

interface AmazonClient {
  login(credentials: AmazonCredentials, options?: AmazonLoginOptions): Promise<void>;
  fetchCashOuts(period: Period): Promise<CashOut[]>;
}

export interface CLIEnvironment {
  getEnv(name: string): string | undefined;
  askText(message: string): Promise<string>;
  askSecret(message: string): Promise<string>;
  write(message: string): void;
  createJCB(walletID: string): JCBClient;
  createAmazon?(walletID: string): AmazonClient;
}

export interface JCBFetchArguments {
  walletID: string;
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
  createJCB: (walletID) => new JCBAdapter({ walletID }),
  createAmazon: (walletID) => new AmazonAdapter({ walletID }),
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
  if (args[1] !== "fetch" || (args[0] !== "jcb" && args[0] !== "amazon")) {
    throw new TypeError(`unknown command\n\n${usage()}`);
  }

  if (args[0] === "amazon") return await runAmazonFetch(args.slice(2), environment);
  return await runJCBFetch(args.slice(2), environment);
}

async function runJCBFetch(args: string[], environment: CLIEnvironment): Promise<number> {
  const options = parseJCBFetchArguments(args);
  const userID = environment.getEnv("JCB_USER_ID")?.trim() ||
    (await environment.askText("MyJCB user ID:")).trim();
  const password = environment.getEnv("JCB_PASSWORD") ||
    await environment.askSecret("MyJCB password: ");
  if (userID === "") throw new TypeError("MyJCB user ID is required");
  if (password === "") throw new TypeError("MyJCB password is required");

  const adapter = environment.createJCB(options.walletID);
  await adapter.login({ userID, password });
  const cashOuts = await adapter.fetchCashOuts(options.period);
  environment.write(formatCashOuts(cashOuts, options));
  return 0;
}

async function runAmazonFetch(args: string[], environment: CLIEnvironment): Promise<number> {
  const options = parseAmazonFetchArguments(args);
  const email = normalizeAmazonEmail(
    environment.getEnv("AMAZON_EMAIL")?.trim() ||
      (await environment.askText("Amazon email: ")).trim(),
  );
  const password = environment.getEnv("AMAZON_PASSWORD") ||
    await environment.askSecret("Amazon password: ");
  if (email === "") throw new TypeError("Amazon email is required");
  if (password === "") throw new TypeError("Amazon password is required");

  const adapter = environment.createAmazon?.(options.walletID) ??
    new AmazonAdapter({ walletID: options.walletID });
  await adapter.login({ email, password }, {
    askVerificationCode: async () =>
      await environment.askText("Amazon verification code (if requested): "),
  });
  const cashOuts = await adapter.fetchCashOuts(options.period);
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
  if (fromLabel === "") throw new TypeError("--from is required");
  if (toLabel === "") throw new TypeError("--to is required");
  const from = parseJSTDate(fromLabel, "--from");
  const toInclusive = parseJSTDate(toLabel, "--to");
  if (from.getTime() > toInclusive.getTime()) {
    throw new TypeError("--from must not be after --to");
  }
  return {
    walletID,
    fromLabel,
    toLabel,
    period: { from, to: new Date(toInclusive.getTime() + DAY_MS) },
    format,
  };
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
  --from DATE          First date to fetch (inclusive)
  --to DATE            Last date to fetch (inclusive)
  --format table|json  Output format (default: table)

Credentials:
  Enter interactively, or set JCB_USER_ID/JCB_PASSWORD or
  AMAZON_EMAIL/AMAZON_PASSWORD.`;
}
