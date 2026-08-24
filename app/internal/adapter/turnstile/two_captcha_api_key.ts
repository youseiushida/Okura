import type {
  ExternalServiceSecretOptions,
  ExternalServiceSecretPort,
} from "../../port/external_service_secret.ts";
import type { SecretStorePort } from "../../port/secret_store.ts";

const ENVIRONMENT_NAME = "TWOCAPTCHA_API_KEY";
const KEYRING_SERVICE = "Okura 2Captcha API key v1";
const KEYRING_ACCOUNT = "default";
const API_KEY_PATTERN = /^[0-9a-f]{32}$/i;

export class TwoCaptchaApiKeyUnavailableError extends Error {
  override name = "TwoCaptchaApiKeyUnavailableError";

  constructor() {
    super(
      "2Captcha API key is not configured; set TWOCAPTCHA_API_KEY or run " +
        '"okura solver 2captcha configure"',
    );
  }
}

/** 2Captchaの共有API keyを環境変数優先で解決し、OS keyringへ明示保存する。 */
export class TwoCaptchaApiKey implements ExternalServiceSecretPort {
  readonly #store: SecretStorePort;
  readonly #getEnvironment: (name: string) => string | undefined;

  constructor(
    store: SecretStorePort,
    getEnvironment: (name: string) => string | undefined = (name) => Deno.env.get(name),
  ) {
    this.#store = store;
    this.#getEnvironment = getEnvironment;
  }

  async resolve(options: ExternalServiceSecretOptions = {}): Promise<string> {
    options.signal?.throwIfAborted();
    const environment = this.#getEnvironment(ENVIRONMENT_NAME);
    if (environment !== undefined) return validateApiKey(environment);

    const stored = await this.#store.get(KEYRING_SERVICE, KEYRING_ACCOUNT, options);
    options.signal?.throwIfAborted();
    if (stored === undefined) throw new TwoCaptchaApiKeyUnavailableError();
    return validateApiKey(stored);
  }

  async configure(
    secret: string,
    options: ExternalServiceSecretOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const validated = validateApiKey(secret);
    await this.#store.set(KEYRING_SERVICE, KEYRING_ACCOUNT, validated, options);
    options.signal?.throwIfAborted();
  }

  async remove(options: ExternalServiceSecretOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    await this.#store.remove(KEYRING_SERVICE, KEYRING_ACCOUNT, options);
    options.signal?.throwIfAborted();
  }
}

function validateApiKey(value: unknown): string {
  if (typeof value !== "string" || !API_KEY_PATTERN.test(value)) {
    throw new TypeError("2Captcha API key must be a 32-character hexadecimal string");
  }
  return value;
}
