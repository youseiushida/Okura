import type { SecretStoreOptions, SecretStorePort } from "../port/secret_store.ts";

export interface SecretStoreCall {
  readonly operation: "get" | "set" | "remove";
  readonly service: string;
  readonly account: string;
}

export class FakeSecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  readonly calls: SecretStoreCall[] = [];
  getError?: unknown;
  setError?: unknown;
  removeError?: unknown;

  get(
    service: string,
    account: string,
    options: SecretStoreOptions = {},
  ): Promise<string | undefined> {
    options.signal?.throwIfAborted();
    this.calls.push({ operation: "get", service, account });
    if (this.getError !== undefined) return Promise.reject(this.getError);
    return Promise.resolve(this.values.get(key(service, account)));
  }

  set(
    service: string,
    account: string,
    secret: string,
    options: SecretStoreOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    this.calls.push({ operation: "set", service, account });
    if (this.setError !== undefined) return Promise.reject(this.setError);
    this.values.set(key(service, account), secret);
    return Promise.resolve();
  }

  remove(
    service: string,
    account: string,
    options: SecretStoreOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    this.calls.push({ operation: "remove", service, account });
    if (this.removeError !== undefined) return Promise.reject(this.removeError);
    this.values.delete(key(service, account));
    return Promise.resolve();
  }
}

function key(service: string, account: string): string {
  return `${service}\u0000${account}`;
}
