import {
  isSupportedProvider,
  parseSessionConnection,
  type SupportedProviderID,
} from "./arguments.ts";
import { defaultEnvironment } from "./default_environment.ts";
import { runFetchCommand } from "./fetch_command.ts";
import type { CLIEnvironment } from "./runtime.ts";
import { usage } from "./usage.ts";

export async function runCLI(
  rawArguments: string[],
  environment: CLIEnvironment = defaultEnvironment,
): Promise<number> {
  const args = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    environment.write(usage());
    return 0;
  }

  if (args[0] === "solver") {
    return await runSolverCommand(args.slice(1), environment);
  }

  const provider = args[0];
  if (!isSupportedProvider(provider)) {
    throw new TypeError(`unknown command\n\n${usage()}`);
  }

  if (args[1] === "fetch") {
    return await runFetchCommand(provider, args.slice(2), environment);
  }
  if (args[1] === "session" && args[2] === "remove") {
    return await removeSession(provider, args.slice(3), environment);
  }
  if (args[1] === "credentials" && args[2] === "remove") {
    return await removeCredentials(provider, args.slice(3), environment);
  }
  throw new TypeError(`unknown command\n\n${usage()}`);
}

async function runSolverCommand(
  args: string[],
  environment: CLIEnvironment,
): Promise<number> {
  if (args.length !== 2 || args[0] !== "2captcha") {
    throw new TypeError(`unknown command\n\n${usage()}`);
  }
  const configuration = environment.createTwoCaptchaApiKeyConfiguration();
  if (args[1] === "configure") {
    const apiKey = await environment.askSecret("2Captcha API key: ");
    await configuration.configure(apiKey);
    environment.write("Saved the 2Captcha API key in the OS credential store.");
    return 0;
  }
  if (args[1] === "remove") {
    await configuration.remove();
    environment.write("Removed the saved 2Captcha API key.");
    return 0;
  }
  throw new TypeError(`unknown command\n\n${usage()}`);
}

async function removeCredentials(
  provider: SupportedProviderID,
  args: string[],
  environment: CLIEnvironment,
): Promise<number> {
  const connection = parseSessionConnection(provider, args);
  await environment.createCredentialVault().remove(connection);
  environment.write(
    `Removed saved credentials for connection ${connection.id}; the saved session was retained.`,
  );
  return 0;
}

async function removeSession(
  provider: SupportedProviderID,
  args: string[],
  environment: CLIEnvironment,
): Promise<number> {
  const connection = parseSessionConnection(provider, args);
  await environment.createSessionVault().remove(connection);
  environment.write(`Removed saved session for connection ${connection.id}.`);
  return 0;
}
