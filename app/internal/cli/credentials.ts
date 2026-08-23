import type { EmailPasswordCredentials, UserIDPasswordCredentials } from "../port/credentials.ts";
import type { CLIIO } from "./runtime.ts";

export async function readJCBCredentials(io: CLIIO): Promise<UserIDPasswordCredentials> {
  const userID = io.getEnv("JCB_USER_ID")?.trim() ||
    (await io.askText("MyJCB user ID:")).trim();
  const password = io.getEnv("JCB_PASSWORD") || await io.askSecret("MyJCB password: ");

  if (userID === "") throw new TypeError("MyJCB user ID is required");
  if (password === "") throw new TypeError("MyJCB password is required");
  return { userID, password };
}

export async function readAmazonCredentials(io: CLIIO): Promise<EmailPasswordCredentials> {
  return await readEmailPassword(io, {
    emailEnvironmentVariable: "AMAZON_EMAIL",
    passwordEnvironmentVariable: "AMAZON_PASSWORD",
    emailPrompt: "Amazon email: ",
    passwordPrompt: "Amazon password: ",
    displayName: "Amazon",
  });
}

export async function readMoneyForwardCredentials(
  io: CLIIO,
): Promise<EmailPasswordCredentials> {
  return await readEmailPassword(io, {
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

async function readEmailPassword(
  io: CLIIO,
  policy: EmailPasswordPolicy,
): Promise<EmailPasswordCredentials> {
  const email = normalizeEmail(
    io.getEnv(policy.emailEnvironmentVariable)?.trim() ||
      (await io.askText(policy.emailPrompt)).trim(),
  );
  const password = io.getEnv(policy.passwordEnvironmentVariable) ||
    await io.askSecret(policy.passwordPrompt);

  if (email === "") throw new TypeError(`${policy.displayName} email is required`);
  if (password === "") throw new TypeError(`${policy.displayName} password is required`);
  return { email, password };
}

function normalizeEmail(value: string): string {
  return value.replaceAll("\\@", "@").replaceAll("＠", "@");
}
