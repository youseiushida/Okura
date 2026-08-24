import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert/";
import type {
  ExternalServiceSecretOptions,
  ExternalServiceSecretPort,
} from "../port/external_service_secret.ts";
import { ConfigureExternalServiceSecret } from "./external_service_secret.ts";

Deno.test("ConfigureExternalServiceSecret delegates explicit configure and remove commands", async () => {
  const port = new FakeExternalServiceSecret();
  const useCase = new ConfigureExternalServiceSecret(port);

  await useCase.configure("test-secret");
  await useCase.remove();

  assertEquals(port.calls, ["configure", "remove"]);
  assertEquals(port.configured, "test-secret");
});

Deno.test("ConfigureExternalServiceSecret preserves an already aborted signal", async () => {
  const port = new FakeExternalServiceSecret();
  const useCase = new ConfigureExternalServiceSecret(port);
  const reason = new DOMException("cancelled", "AbortError");
  const controller = new AbortController();
  controller.abort(reason);

  const error = await assertRejects(() =>
    useCase.configure("test-secret", {
      signal: controller.signal,
    })
  );

  assertStrictEquals(error, reason);
  assertEquals(port.calls, []);
});

class FakeExternalServiceSecret implements ExternalServiceSecretPort {
  readonly calls: string[] = [];
  configured?: string;

  configure(
    secret: string,
    _options?: ExternalServiceSecretOptions,
  ): Promise<void> {
    this.calls.push("configure");
    this.configured = secret;
    return Promise.resolve();
  }

  remove(_options?: ExternalServiceSecretOptions): Promise<void> {
    this.calls.push("remove");
    return Promise.resolve();
  }
}
