import { posix, win32 } from "node:path";
import type { SecretStorePort } from "../../port/secret_store.ts";
import type { SessionVaultPort } from "../../port/session_vault.ts";
import { AesGcmDataProtector, KeyringMasterKeyProvider } from "./encrypted_vault.ts";
import { FileSessionVault } from "./file_vault.ts";

export function createDefaultSessionVault(secretStore: SecretStorePort): SessionVaultPort {
  const root = sessionVaultRoot();
  return new FileSessionVault(
    root,
    new AesGcmDataProtector(new KeyringMasterKeyProvider(secretStore, root)),
  );
}

export function sessionVaultRoot(
  os: typeof Deno.build.os = Deno.build.os,
  getEnvironment: (name: string) => string | undefined = (name) => Deno.env.get(name),
): string {
  switch (os) {
    case "windows": {
      const localAppData = requiredEnvironment("LOCALAPPDATA", getEnvironment);
      return win32.join(localAppData, "Okura", "sessions", "aes-gcm-v1");
    }
    case "darwin": {
      const home = requiredEnvironment("HOME", getEnvironment);
      return posix.join(
        home,
        "Library",
        "Application Support",
        "Okura",
        "sessions",
        "aes-gcm-v1",
      );
    }
    case "linux": {
      const xdgDataHome = getEnvironment("XDG_DATA_HOME")?.trim();
      const dataHome = xdgDataHome === undefined || xdgDataHome === ""
        ? posix.join(requiredEnvironment("HOME", getEnvironment), ".local", "share")
        : xdgDataHome;
      return posix.join(dataHome, "Okura", "sessions", "aes-gcm-v1");
    }
    default:
      throw new Error(`persistent session storage is unsupported on ${Deno.build.os}`);
  }
}

function requiredEnvironment(
  name: string,
  getEnvironment: (name: string) => string | undefined,
): string {
  const value = getEnvironment(name);
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is unavailable`);
  }
  return value;
}
