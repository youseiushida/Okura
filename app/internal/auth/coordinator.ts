import type { AuthInteraction } from "../port/auth_interaction.ts";
import type {
  AuthenticationOptions,
  AuthenticationPort,
  ProviderSessionSnapshot,
} from "../port/authentication.ts";
import type { SessionKey, SessionVaultOptions, SessionVaultPort } from "../port/session_vault.ts";

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
}

export interface EnsureAuthenticationOptions<Credentials> extends AuthenticationOptions {
  readonly key: SessionKey;
  readonly interaction: AuthInteraction;

  /**
   * 保存済みセッションが利用できなかった場合にだけ呼ばれる。
   */
  readonly getCredentials: (
    options?: AuthenticationOptions,
  ) => Promise<Credentials>;
}

/**
 * セッション復元、server側検証、新規ログイン、再保存を調停する。
 *
 * provider固有の認証手順とsnapshot検証はAuthenticationPortへ、
 * 暗号化と永続化はSessionVaultPortへ委譲する。
 */
export class AuthCoordinator<Credentials> {
  readonly #auth: AuthenticationPort<Credentials>;
  readonly #vault: SessionVaultPort;

  constructor(
    auth: AuthenticationPort<Credentials>,
    vault: SessionVaultPort,
  ) {
    this.#auth = auth;
    this.#vault = vault;
  }

  async ensureAuthenticated(
    options: EnsureAuthenticationOptions<Credentials>,
  ): Promise<EnsureAuthenticationResult> {
    const { key, interaction, getCredentials, signal } = options;

    if (key.provider !== this.#auth.provider) {
      throw new TypeError(
        `session key provider ${JSON.stringify(key.provider)} does not match ` +
          `authentication provider ${JSON.stringify(this.#auth.provider)}`,
      );
    }

    signal?.throwIfAborted();
    const snapshot = await this.#vault.load(key, { signal });
    signal?.throwIfAborted();

    if (snapshot !== undefined) {
      // restoreSessionは外部由来のsnapshotを検証する信頼境界。
      // 復元エラーの種類を推測せず、そのまま呼び出し元へ返す。
      this.#auth.restoreSession(snapshot);

      const validation = await this.#auth.validateSession({ signal });
      signal?.throwIfAborted();

      if (validation.status === "valid") {
        // validateSessionの応答でCookieが更新されることがあるため再保存する。
        return {
          session: "reused",
          persistence: await this.#persist(key, { signal }),
        };
      }
    } 
    // expiredまたはsnapshotなし。
    // 新規ログインを必ず空の状態から開始する。
    this.#auth.clearSession();

    signal?.throwIfAborted();
    const credentials = await getCredentials({ signal });
    signal?.throwIfAborted();

    try {
      await this.#auth.login(credentials, { interaction, signal });
      signal?.throwIfAborted();
    } catch (error) {
      // clearSessionが失敗しても本来の認証エラーを失わない。
      try {
        this.#auth.clearSession();
      } catch {
        // clearSessionはbest effort。呼び出し元には認証失敗を返す。
      }
      throw error;
    }

    return {
      session: "created",
      persistence: await this.#persist(key, { signal }),
    };
  }

  async #persist(
    key: SessionKey,
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

function assertSnapshotProvider(
  snapshot: ProviderSessionSnapshot,
  key: SessionKey,
): void {
  if (snapshot.provider === key.provider) return;

  throw new TypeError(
    `snapshot provider ${JSON.stringify(snapshot.provider)} does not match ` +
      `session key provider ${JSON.stringify(key.provider)}`,
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
