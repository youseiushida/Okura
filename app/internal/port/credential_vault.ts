import type { ConnectionID, ProviderConnection } from "../model/connection.ts";
import type { ProviderID } from "./provider.ts";

export type CredentialKey<Provider extends ProviderID = ProviderID> = ProviderConnection<Provider>;

export interface CredentialVaultOptions {
  readonly signal?: AbortSignal;
}

/**
 * OS credential storeへ保存する、再利用可能な一次認証情報。
 *
 * OTP、TOTP seed、秘密の質問、外部承認結果など、一時的または
 * 追加要素の認証情報をこの型へ加えてはいけない。
 */
export interface StoredPasswordCredential<Provider extends ProviderID = ProviderID> {
  readonly schemaVersion: 1;
  readonly provider: Provider;
  readonly connectionID: ConnectionID;
  readonly identifier: string;
  readonly password: string;
}

/**
 * Provider/profileごとの一次認証情報をOS credential storeへ永続化するPort。
 *
 * load結果は外部入力なので、Application層で完全に検証してから利用する。
 * 存在しない場合だけundefinedを返し、破損、lock、access拒否は例外にする。
 */
export interface CredentialVaultPort {
  load<Provider extends ProviderID>(
    key: CredentialKey<Provider>,
    options?: CredentialVaultOptions,
  ): Promise<unknown | undefined>;

  save<Provider extends ProviderID>(
    key: CredentialKey<Provider>,
    credential: StoredPasswordCredential<Provider>,
    options?: CredentialVaultOptions,
  ): Promise<void>;

  remove<Provider extends ProviderID>(
    key: CredentialKey<Provider>,
    options?: CredentialVaultOptions,
  ): Promise<void>;
}
