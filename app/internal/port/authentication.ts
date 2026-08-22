import type { AuthInteraction } from "./auth_interaction.ts";
import type { ProviderID } from "./provider.ts";

export type JsonPrimitive =
  | null
  | boolean
  | number
  | string;

export type JsonValue =
  | JsonPrimitive
  | JsonObject
  | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface ProviderSessionSnapshot {
  /**
   * providerごとのsnapshot schema version。
   */
  readonly schemaVersion: number;

  /**
   * 復元先取り違え防止のためpayload内にも保持する。
   */
  readonly provider: ProviderID;

  /**
   * ISO 8601形式。
   */
  readonly capturedAt: string;

  /**
   * Cookieとprovider固有状態。
   *
   * password、OTP、秘密の質問の回答などを
   * 含めてはいけない。
   */
  readonly payload: JsonObject;
}

export type SessionValidation =
  | {
    readonly status: "valid";
  }
  | {
    readonly status: "expired";
  };

export interface AuthenticationOptions {
  readonly signal?: AbortSignal;
}

export interface LoginOptions extends AuthenticationOptions {
  readonly interaction: AuthInteraction;
}

/**
 * providerの認証済みHTTPセッションを管理するPort。
 *
 * Credentialsはprovider固有の型とする。
 */
export interface AuthenticationPort<Credentials> {
  readonly provider: ProviderID;

  /**
   * 保存済みsnapshotをProviderContextへ復元する。
   *
   * snapshotは暗号化ファイルなど外部由来なので
   * unknownとして受け取り、完全に検証する。
   *
   * 復元しただけでは認証済みとして扱ってはいけない。
   */
  restoreSession(snapshot: unknown): void;

  /**
   * 現在のCookieで認証済みページへアクセスし、
   * server側でセッションが有効か確認する。
   *
   * ログインやOTP要求を開始してはいけない。
   *
   * 401やログイン画面への遷移はexpired。
   * 通信障害、500、WAF、CAPTCHAは例外にする。
   */
  validateSession(
    options?: AuthenticationOptions,
  ): Promise<SessionValidation>;

  /**
   * 新規ログインを実行する。
   *
   * 最終的な認証済みページを確認した後にだけ成功する。
   */
  login(
    credentials: Credentials,
    options: LoginOptions,
  ): Promise<void>;

  /**
   * 認証済みProviderContextを永続化可能な形式へ変換する。
   *
   * 有効性未確認の状態では例外にする。
   */
  captureSession(): ProviderSessionSnapshot;

  /**
   * Cookieとprovider固有認証状態をメモリから消去する。
   *
   * serverへのlogout通信は行わない。
   */
  clearSession(): void;
}
