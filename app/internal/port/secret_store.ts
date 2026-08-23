export interface SecretStoreOptions {
  readonly signal?: AbortSignal;
}

/**
 * OSが提供する利用者単位の秘密ストアを表す低水準Port。
 *
 * 保存する秘密のschemaや用途は、このPortを利用するadapter側で分離する。
 */
export interface SecretStorePort {
  get(
    service: string,
    account: string,
    options?: SecretStoreOptions,
  ): Promise<string | undefined>;

  set(
    service: string,
    account: string,
    secret: string,
    options?: SecretStoreOptions,
  ): Promise<void>;

  remove(
    service: string,
    account: string,
    options?: SecretStoreOptions,
  ): Promise<void>;
}
