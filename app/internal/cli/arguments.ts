import { createProviderConnection, type ProviderConnection } from "../model/connection.ts";
import type { Period } from "../port/source.ts";
import { DAY_MS, parseJSTDate } from "./date.ts";

export const SUPPORTED_PROVIDER_IDS = ["jcb", "amazon", "moneyforward"] as const;
export type SupportedProviderID = (typeof SUPPORTED_PROVIDER_IDS)[number];

export interface FetchArguments<Provider extends SupportedProviderID = SupportedProviderID> {
  readonly walletID: string;
  readonly connection: ProviderConnection<Provider>;
  readonly reauthenticate: boolean;
  readonly saveCredentials: boolean;
  readonly period: Period;
  readonly periodLabels: {
    readonly from: string;
    readonly to: string;
  };
  readonly format: "table" | "json";
}

export function isSupportedProvider(value: string | undefined): value is SupportedProviderID {
  return SUPPORTED_PROVIDER_IDS.some((provider) => provider === value);
}

export function parseJCBFetchArguments(args: string[]): FetchArguments<"jcb"> {
  return parseFetchArguments(args, "jcb", "jcb");
}

export function parseAmazonFetchArguments(args: string[]): FetchArguments<"amazon"> {
  return parseFetchArguments(args, "amazon", "amazon");
}

export function parseMoneyForwardFetchArguments(
  args: string[],
): FetchArguments<"moneyforward"> {
  if (args.includes("--wallet-id")) {
    throw new TypeError("--wallet-id is not available for moneyforward; wallets are discovered");
  }
  return parseFetchArguments(args, "moneyforward", "moneyforward");
}

export function parseSessionConnection<Provider extends SupportedProviderID>(
  provider: Provider,
  args: string[],
): ProviderConnection<Provider> {
  let profile = "default";
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--") continue;
    if (name !== "--profile") {
      throw new TypeError(`unknown option ${JSON.stringify(name)}`);
    }
    profile = requiredOptionValue(args, index, "--profile");
    index += 1;
  }
  return createProviderConnection(provider, profile);
}

function parseFetchArguments<Provider extends SupportedProviderID>(
  args: string[],
  provider: Provider,
  defaultWalletID: string,
): FetchArguments<Provider> {
  let walletID = defaultWalletID;
  let profile = "default";
  let fromLabel = "";
  let toLabel = "";
  let format: FetchArguments["format"] = "table";
  let reauthenticate = false;
  let saveCredentials = false;

  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--") continue;
    if (name === "--reauth") {
      reauthenticate = true;
      continue;
    }
    if (name === "--save-credentials") {
      saveCredentials = true;
      continue;
    }

    const value = requiredOptionValue(args, index, name);
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
  if (fromLabel === "") throw new TypeError("--from is required");
  if (toLabel === "") throw new TypeError("--to is required");

  const from = parseJSTDate(fromLabel, "--from");
  const toInclusive = parseJSTDate(toLabel, "--to");
  if (from.getTime() > toInclusive.getTime()) {
    throw new TypeError("--from must not be after --to");
  }

  return {
    walletID,
    connection: createProviderConnection(provider, profile),
    reauthenticate,
    saveCredentials,
    periodLabels: { from: fromLabel, to: toLabel },
    period: { from, to: new Date(toInclusive.getTime() + DAY_MS) },
    format,
  };
}

function requiredOptionValue(args: string[], index: number, name: string | undefined): string {
  const value = args[index + 1];
  if (name === undefined || value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return value;
}
