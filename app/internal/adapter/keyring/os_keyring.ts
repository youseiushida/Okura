import type { SecretStoreOptions, SecretStorePort } from "../../port/secret_store.ts";

const MAX_SECRET_BYTES = 16 << 10;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NAPI_NATIVE_LIBRARY_OVERRIDE = "NAPI_RS_NATIVE_LIBRARY_PATH";

/** 継承環境から任意のnative bindingを読み込ませない。 */
export function assertSafeNapiEnvironment(
  getEnvironment: (name: string) => string | undefined = (name) => Deno.env.get(name),
): void {
  const override = getEnvironment(NAPI_NATIVE_LIBRARY_OVERRIDE);
  if (override !== undefined && override.trim() !== "") {
    throw new Error(`${NAPI_NATIVE_LIBRARY_OVERRIDE} overrides are not supported`);
  }
}

export class NapiKeyringSecretStore implements SecretStorePort {
  readonly #getEnvironment: (name: string) => string | undefined;

  constructor(
    getEnvironment: (name: string) => string | undefined = (name) => Deno.env.get(name),
  ) {
    this.#getEnvironment = getEnvironment;
  }

  async get(
    service: string,
    account: string,
    options: SecretStoreOptions = {},
  ): Promise<string | undefined> {
    options.signal?.throwIfAborted();
    assertSafeNapiEnvironment(this.#getEnvironment);
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      // 同期APIと同様、一部backendは型定義に反して未登録時にnullを返す。
      const value: string | null | undefined = await new AsyncEntry(service, account).getPassword(
        options.signal,
      );
      return value ?? undefined;
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new Error("OS credential store read failed", { cause: error });
    }
  }

  async set(
    service: string,
    account: string,
    secret: string,
    options: SecretStoreOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    assertSafeNapiEnvironment(this.#getEnvironment);
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      await new AsyncEntry(service, account).setPassword(secret, options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new Error("OS credential store write failed", { cause: error });
    }
  }

  async remove(
    service: string,
    account: string,
    options: SecretStoreOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    assertSafeNapiEnvironment(this.#getEnvironment);
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      await new AsyncEntry(service, account).deleteCredential(options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new Error("OS credential store removal failed", { cause: error });
    }
  }
}

/** Linux Secret Serviceをsecret-tool経由で明示利用する。 */
export class LinuxSecretServiceStore implements SecretStorePort {
  async get(
    service: string,
    account: string,
    options: SecretStoreOptions = {},
  ): Promise<string | undefined> {
    const result = await runSecretTool(
      ["lookup", "service", service, "account", account],
      undefined,
      options.signal,
    );
    if (result.code === 1 && result.stdout.byteLength === 0 && result.stderr.byteLength === 0) {
      return undefined;
    }
    assertSecretToolSuccess(result, "read");
    return decoder.decode(result.stdout).replace(/[\r\n]+$/, "");
  }

  async set(
    service: string,
    account: string,
    secret: string,
    options: SecretStoreOptions = {},
  ): Promise<void> {
    const result = await runSecretTool(
      ["store", `--label=${service}`, "service", service, "account", account],
      encoder.encode(secret),
      options.signal,
    );
    assertSecretToolSuccess(result, "write");
  }

  async remove(
    service: string,
    account: string,
    options: SecretStoreOptions = {},
  ): Promise<void> {
    const result = await runSecretTool(
      ["clear", "service", service, "account", account],
      undefined,
      options.signal,
    );
    if (result.code === 1 && result.stderr.byteLength === 0) return;
    assertSecretToolSuccess(result, "removal");
  }
}

export function createDefaultSecretStore(): SecretStorePort {
  switch (Deno.build.os) {
    case "windows":
    case "darwin":
      return new NapiKeyringSecretStore();
    case "linux":
      return new LinuxSecretServiceStore();
    default:
      throw new Error(`OS credential storage is unsupported on ${Deno.build.os}`);
  }
}

interface SecretToolResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

async function runSecretTool(
  args: string[],
  input: Uint8Array | undefined,
  signal?: AbortSignal,
): Promise<SecretToolResult> {
  signal?.throwIfAborted();
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("secret-tool", {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    throw new Error(
      "Linux Secret Service requires the secret-tool command and an unlocked user session",
      { cause: error },
    );
  }
  const abort = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Process may already have exited.
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const writer = child.stdin.getWriter();
    if (input !== undefined) await writer.write(input);
    await writer.close();
    const output = await child.output();
    signal?.throwIfAborted();
    if (output.stdout.byteLength > MAX_SECRET_BYTES) {
      throw new Error("Linux Secret Service returned an oversized secret");
    }
    return { code: output.code, stdout: output.stdout, stderr: output.stderr };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function assertSecretToolSuccess(result: SecretToolResult, operation: string): void {
  if (result.code === 0) return;
  const detail = decoder.decode(result.stderr).replace(/\s+/g, " ").trim().slice(0, 300);
  throw new Error(
    `Linux Secret Service ${operation} failed${detail === "" ? "" : `: ${detail}`}`,
  );
}
