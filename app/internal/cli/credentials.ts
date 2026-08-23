import { type CredentialInput, storedPasswordCredential } from "../application/credentials.ts";
import type { AuthenticationOptions } from "../port/authentication.ts";
import type { StoredPasswordCredential } from "../port/credential_vault.ts";
import type { EmailPasswordCredentials, UserIDPasswordCredentials } from "../port/credentials.ts";
import type { CLIIO } from "./runtime.ts";

export function jcbCredentialInput(
  io: CLIIO,
): CredentialInput<"jcb", UserIDPasswordCredentials> {
  return {
    readEnvironment: async (options) => {
      const userID = nonEmptyEnvironment(io.getEnv("JCB_USER_ID"));
      const password = nonEmptyEnvironment(io.getEnv("JCB_PASSWORD"), false);
      if (userID === undefined && password === undefined) return undefined;
      return await readJCB(io, { userID, password }, options);
    },
    prompt: (options) => readJCB(io, {}, options),
    fromStored: (credential) => ({
      userID: credential.identifier,
      password: credential.password,
    }),
    toStored: (key, credential) =>
      storedPasswordCredential(key, credential.userID, credential.password),
  };
}

export function amazonCredentialInput(
  io: CLIIO,
): CredentialInput<"amazon", EmailPasswordCredentials> {
  return emailPasswordInput(io, "amazon", {
    emailEnvironmentVariable: "AMAZON_EMAIL",
    passwordEnvironmentVariable: "AMAZON_PASSWORD",
    emailPrompt: "Amazon email: ",
    passwordPrompt: "Amazon password: ",
    displayName: "Amazon",
  });
}

export function moneyForwardCredentialInput(
  io: CLIIO,
): CredentialInput<"moneyforward", EmailPasswordCredentials> {
  return emailPasswordInput(io, "moneyforward", {
    emailEnvironmentVariable: "MONEYFORWARD_EMAIL",
    passwordEnvironmentVariable: "MONEYFORWARD_PASSWORD",
    emailPrompt: "Money Forward email: ",
    passwordPrompt: "Money Forward password: ",
    displayName: "Money Forward",
  });
}

interface EmailPasswordPolicy {
  readonly emailEnvironmentVariable: string;
  readonly passwordEnvironmentVariable: string;
  readonly emailPrompt: string;
  readonly passwordPrompt: string;
  readonly displayName: string;
}

function emailPasswordInput<Provider extends "amazon" | "moneyforward">(
  io: CLIIO,
  _provider: Provider,
  policy: EmailPasswordPolicy,
): CredentialInput<Provider, EmailPasswordCredentials> {
  return {
    readEnvironment: async (options) => {
      const email = nonEmptyEnvironment(io.getEnv(policy.emailEnvironmentVariable));
      const password = nonEmptyEnvironment(io.getEnv(policy.passwordEnvironmentVariable), false);
      if (email === undefined && password === undefined) return undefined;
      return await readEmailPassword(io, policy, { email, password }, options);
    },
    prompt: (options) => readEmailPassword(io, policy, {}, options),
    fromStored: (credential: StoredPasswordCredential<Provider>) => ({
      email: normalizeEmail(credential.identifier),
      password: credential.password,
    }),
    toStored: (key, credential) =>
      storedPasswordCredential(key, normalizeEmail(credential.email), credential.password),
  };
}

async function readJCB(
  io: CLIIO,
  supplied: Partial<UserIDPasswordCredentials>,
  options: AuthenticationOptions = {},
): Promise<UserIDPasswordCredentials> {
  options.signal?.throwIfAborted();
  const userID = supplied.userID ?? (await io.askText("MyJCB user ID:")).trim();
  options.signal?.throwIfAborted();
  const password = supplied.password ?? await io.askSecret("MyJCB password: ");
  options.signal?.throwIfAborted();
  if (userID === "") throw new TypeError("MyJCB user ID is required");
  if (password === "") throw new TypeError("MyJCB password is required");
  return { userID, password };
}

async function readEmailPassword(
  io: CLIIO,
  policy: EmailPasswordPolicy,
  supplied: Partial<EmailPasswordCredentials>,
  options: AuthenticationOptions = {},
): Promise<EmailPasswordCredentials> {
  options.signal?.throwIfAborted();
  const email = normalizeEmail(
    supplied.email ?? (await io.askText(policy.emailPrompt)).trim(),
  );
  options.signal?.throwIfAborted();
  const password = supplied.password ?? await io.askSecret(policy.passwordPrompt);
  options.signal?.throwIfAborted();
  if (email === "") throw new TypeError(`${policy.displayName} email is required`);
  if (password === "") throw new TypeError(`${policy.displayName} password is required`);
  return { email, password };
}

function nonEmptyEnvironment(value: string | undefined, trim = true): string | undefined {
  if (value === undefined) return undefined;
  const normalized = trim ? value.trim() : value;
  return normalized === "" ? undefined : normalized;
}

function normalizeEmail(value: string): string {
  return value.replaceAll("\\@", "@").replaceAll("＠", "@");
}
