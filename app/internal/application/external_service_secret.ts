import type {
  ExternalServiceSecretOptions,
  ExternalServiceSecretPort,
} from "../port/external_service_secret.ts";

export interface ExternalServiceSecretConfigurationUseCase {
  configure(secret: string, options?: ExternalServiceSecretOptions): Promise<void>;
  remove(options?: ExternalServiceSecretOptions): Promise<void>;
}

export class ConfigureExternalServiceSecret implements ExternalServiceSecretConfigurationUseCase {
  readonly #secret: ExternalServiceSecretPort;

  constructor(secret: ExternalServiceSecretPort) {
    this.#secret = secret;
  }

  async configure(
    value: string,
    options: ExternalServiceSecretOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    await this.#secret.configure(value, options);
    options.signal?.throwIfAborted();
  }

  async remove(options: ExternalServiceSecretOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    await this.#secret.remove(options);
    options.signal?.throwIfAborted();
  }
}
