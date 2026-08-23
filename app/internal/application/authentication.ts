import type { AuthInteraction } from "../port/auth_interaction.ts";
import type { CredentialVaultPort } from "../port/credential_vault.ts";
import { PrimaryCredentialRejectedError } from "../port/authentication.ts";
import type {
  AuthenticationOptions,
  AuthenticationPort,
  ProviderSessionSnapshot,
  SessionRestoreRejectionReason,
} from "../port/authentication.ts";
import type { ProviderID } from "../port/provider.ts";
import type { SessionKey, SessionVaultOptions, SessionVaultPort } from "../port/session_vault.ts";
import {
  CredentialCoordinator,
  type CredentialInput,
  type CredentialPersistence,
  type CredentialSource,
  SavedCredentialLoginError,
} from "./credentials.ts";

export type SessionPersistence =
  | {
    readonly status: "saved";
  }
  | {
    readonly status: "failed";
    readonly error: unknown;
  };

export interface EnsureAuthenticationResult {
  /**
   * reusedは保存済みセッションがserver上でも有効だったことを表す。
   * createdは新規ログインに成功したことを表す。
   */
  readonly session: "reused" | "created";
  readonly persistence: SessionPersistence;

  readonly credentials:
    | {
      readonly status: "not-required";
      readonly persistence: CredentialPersistence;
    }
    | {
      readonly status: "used";
      readonly source: CredentialSource;
      readonly persistence: CredentialPersistence;
    };

  /**
   * 壊れた・非対応の保存snapshotから新規ログインへ復旧した場合だけ返す。
   */
  readonly recovery?: {
    readonly reason: SessionRestoreRejectionReason;
    readonly storedSnapshot: "removed" | "replaced" | "retained";
  };
}

export type InvalidSessionRecovery = "remove" | "replace";

export interface EnsureAuthenticationOptions<
  Provider extends ProviderID,
  Credentials,
> extends AuthenticationOptions {
  readonly key: SessionKey<Provider>;
  readonly interaction: AuthInteraction;

  /**
   * remove: 新規ログイン前に壊れたsnapshotを削除する。
   * replace: snapshotを残し、新規ログイン成功時のsaveで置換する。
   *
   * 省略時はremove。どちらもrestore失敗で永久停止せず再ログインへ進む。
   */
  readonly invalidSessionRecovery?: InvalidSessionRecovery;

  /** 保存済みsnapshotを削除し、必ず新規ログインする。 */
  readonly forceReauthentication?: boolean;

  /**
   * 保存済みセッションが利用できなかった場合にだけ呼ばれる。
   */
  readonly credentialInput: CredentialInput<Provider, Credentials>;

  /** 新規login成功後にだけ一次認証情報をOS credential storeへ保存する。 */
  readonly saveCredentials?: boolean;
}

/**
 * セッション復元、server側検証、新規ログイン、再保存を調停する。
 *
 * provider固有の認証手順とsnapshot検証はAuthenticationPortへ、
 * 暗号化と永続化はSessionVaultPortへ委譲する。
 */
export class AuthCoordinator<Provider extends ProviderID, Credentials> {
  readonly #auth: AuthenticationPort<Provider, Credentials>;
  readonly #vault: SessionVaultPort;
  readonly #credentialVault: CredentialVaultPort;

  constructor(
    auth: AuthenticationPort<Provider, Credentials>,
    vault: SessionVaultPort,
    credentialVault: CredentialVaultPort,
  ) {
    this.#auth = auth;
    this.#vault = vault;
    this.#credentialVault = credentialVault;
  }

  async ensureAuthenticated(
    options: EnsureAuthenticationOptions<Provider, Credentials>,
  ): Promise<EnsureAuthenticationResult> {
    const { key, interaction, signal } = options;

    if (key.provider !== this.#auth.provider) {
      throw new TypeError(
        `session key provider ${JSON.stringify(key.provider)} does not match ` +
          `authentication provider ${JSON.stringify(this.#auth.provider)}`,
      );
    }
    if (key.id !== this.#auth.connection.id) {
      throw new TypeError(
        `session connection ${JSON.stringify(key.id)} does not match ` +
          `authentication connection ${JSON.stringify(this.#auth.connection.id)}`,
      );
    }

    signal?.throwIfAborted();
    if (options.forceReauthentication === true) {
      await this.#vault.remove(key, { signal });
    }
    const snapshot = options.forceReauthentication === true
      ? undefined
      : await this.#vault.load(key, { signal });
    signal?.throwIfAborted();

    let recovery: EnsureAuthenticationResult["recovery"];
    if (snapshot !== undefined) {
      // restoreSessionは外部由来のsnapshotを検証する信頼境界。
      const restored = this.#auth.restoreSession(snapshot);

      if (restored.status === "restored") {
        const validation = await this.#auth.validateSession({ signal });
        signal?.throwIfAborted();

        if (validation.status === "valid") {
          // validateSessionの応答でCookieが更新されることがあるため再保存する。
          return {
            session: "reused",
            persistence: await this.#persist(key, { signal }),
            credentials: {
              status: "not-required",
              persistence: options.saveCredentials === true
                ? { status: "skipped", reason: "session-reused" }
                : { status: "not-requested" },
            },
          };
        }
      } else {
        const strategy = options.invalidSessionRecovery ?? "remove";
        if (strategy === "remove") {
          await this.#vault.remove(key, { signal });
          signal?.throwIfAborted();
        }
        recovery = {
          reason: restored.reason,
          storedSnapshot: strategy === "remove" ? "removed" : "retained",
        };
      }
    }
    // expiredまたはsnapshotなし。
    // 新規ログインを必ず空の状態から開始する。
    this.#auth.clearSession();

    signal?.throwIfAborted();
    const credentialCoordinator = new CredentialCoordinator(
      this.#credentialVault,
      options.credentialInput,
    );
    const credentials = await credentialCoordinator.acquire(key, { signal });
    signal?.throwIfAborted();

    try {
      await this.#auth.login(credentials.value, { interaction, signal });
      signal?.throwIfAborted();
    } catch (error) {
      // clearSessionが失敗しても本来の認証エラーを失わない。
      try {
        this.#auth.clearSession();
      } catch {
        // clearSessionはbest effort。呼び出し元には認証失敗を返す。
      }
      signal?.throwIfAborted();
      if (
        credentials.source === "keyring" &&
        error instanceof PrimaryCredentialRejectedError &&
        error.provider === key.provider
      ) {
        throw new SavedCredentialLoginError(key.provider, { cause: error });
      }
      throw error;
    }

    const persistence = await this.#persist(key, { signal });
    const credentialPersistence = options.saveCredentials === true
      ? await credentialCoordinator.save(key, credentials, { signal })
      : { status: "not-requested" } as const;
    if (
      recovery?.storedSnapshot === "retained" &&
      persistence.status === "saved"
    ) {
      recovery = { ...recovery, storedSnapshot: "replaced" };
    }
    return {
      session: "created",
      persistence,
      credentials: {
        status: "used",
        source: credentials.source,
        persistence: credentialPersistence,
      },
      ...(recovery === undefined ? {} : { recovery }),
    };
  }

  async #persist(
    key: SessionKey<Provider>,
    options: SessionVaultOptions,
  ): Promise<SessionPersistence> {
    options.signal?.throwIfAborted();
    const snapshot = this.#auth.captureSession();
    assertSnapshotProvider(snapshot, key);

    try {
      await this.#vault.save(key, snapshot, options);
      options.signal?.throwIfAborted();
      return { status: "saved" };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (isAbortError(error)) throw error;
      return {
        status: "failed",
        error,
      };
    }
  }
}

function assertSnapshotProvider<Provider extends ProviderID>(
  snapshot: ProviderSessionSnapshot<Provider>,
  key: SessionKey<Provider>,
): void {
  if (snapshot.provider !== key.provider) {
    throw new TypeError(
      `snapshot provider ${JSON.stringify(snapshot.provider)} does not match ` +
        `session key provider ${JSON.stringify(key.provider)}`,
    );
  }
  if (snapshot.connectionID === key.id) return;

  throw new TypeError(
    `snapshot connection ${JSON.stringify(snapshot.connectionID)} does not match ` +
      `session key connection ${JSON.stringify(key.id)}`,
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
