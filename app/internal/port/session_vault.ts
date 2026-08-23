import type { ProviderSessionSnapshot } from "./authentication.ts";
import type { ProviderID } from "./provider.ts";
import type { ProviderConnection } from "../model/connection.ts";

export type SessionKey<Provider extends ProviderID = ProviderID> = ProviderConnection<Provider>;

export interface SessionVaultOptions {
  readonly signal?: AbortSignal;
}

/**
 * 認証セッションの暗号化永続化Port。
 *
 * 実装例:
 * - OS secret store由来の鍵とAES-GCM file vault
 * - テスト用MemorySessionVault
 */
export interface SessionVaultPort {
  /**
   * 保存データは破損・改ざんされている可能性があるため
   * unknownとして返す。
   *
   * 存在しない場合だけundefinedを返す。
   * 復号失敗やI/O障害は例外にする。
   */
  load<Provider extends ProviderID>(
    key: SessionKey<Provider>,
    options?: SessionVaultOptions,
  ): Promise<unknown | undefined>;

  /**
   * 同じkeyへの保存はatomicに置き換える。
   *
   * key.providerとsnapshot.providerが一致しない場合は
   * TypeErrorを投げ、既存データを変更してはいけない。
   */
  save<Provider extends ProviderID>(
    key: SessionKey<Provider>,
    snapshot: ProviderSessionSnapshot<Provider>,
    options?: SessionVaultOptions,
  ): Promise<void>;

  /**
   * ローカル保存だけを削除する。
   * providerへのlogout通信は行わない。
   */
  remove<Provider extends ProviderID>(
    key: SessionKey<Provider>,
    options?: SessionVaultOptions,
  ): Promise<void>;
}
