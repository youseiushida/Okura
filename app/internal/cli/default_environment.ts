import { FetchCashOuts, FetchFinancialSnapshot } from "../application/fetch.ts";
import { createAmazonModule } from "../adapter/amazon/module.ts";
import { createJCBModule } from "../adapter/jcb/module.ts";
import { createMoneyForwardModule } from "../adapter/moneyforward/module.ts";
import { KeyringCredentialVault } from "../adapter/credential/keyring_vault.ts";
import { createDefaultSecretStore } from "../adapter/keyring/os_keyring.ts";
import { createDefaultSessionVault } from "../adapter/session/default_vault.ts";
import type { CLIEnvironment } from "./runtime.ts";

export const defaultEnvironment: CLIEnvironment = {
  getEnv: (name) => Deno.env.get(name),
  askText: (message) => Promise.resolve(globalThis.prompt(message) ?? ""),
  askSecret: readHiddenLine,
  write: (message) => console.log(message),
  warn: (message) => console.warn(message),
  createSessionVault: () => createDefaultSessionVault(createDefaultSecretStore()),
  createCredentialVault: () => new KeyringCredentialVault(createDefaultSecretStore()),
  createJCBFetch: (connection, walletID) => {
    const module = createJCBModule({ connection, walletID });
    return new FetchCashOuts({
      authentication: module.auth,
      sessionVault: createDefaultSessionVault(createDefaultSecretStore()),
      credentialVault: new KeyringCredentialVault(createDefaultSecretStore()),
      cashOuts: module.sources.cashOuts,
    });
  },
  createAmazonFetch: (connection, walletID) => {
    const module = createAmazonModule({ connection, walletID });
    return new FetchCashOuts({
      authentication: module.auth,
      sessionVault: createDefaultSessionVault(createDefaultSecretStore()),
      credentialVault: new KeyringCredentialVault(createDefaultSecretStore()),
      cashOuts: module.sources.cashOuts,
    });
  },
  createMoneyForwardFetch: (connection) => {
    const module = createMoneyForwardModule({ connection });
    return new FetchFinancialSnapshot({
      authentication: module.auth,
      sessionVault: createDefaultSessionVault(createDefaultSecretStore()),
      credentialVault: new KeyringCredentialVault(createDefaultSecretStore()),
      ...module.sources,
    });
  },
};

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
