export interface ExternalServiceSecretOptions {
  readonly signal?: AbortSignal;
}

/** 外部サービス用の秘密を明示的に設定・削除するためのPort。 */
export interface ExternalServiceSecretPort {
  configure(
    secret: string,
    options?: ExternalServiceSecretOptions,
  ): Promise<void>;

  remove(options?: ExternalServiceSecretOptions): Promise<void>;
}
