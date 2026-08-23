import { assertEquals, assertStringIncludes } from "@std/assert/";
import { join } from "node:path";
import type { ProviderSessionSnapshot } from "../../port/authentication.ts";
import { FileSessionVault, WindowsDPAPIProtector } from "./dpapi_vault.ts";

Deno.test("FileSessionVault persists an opaque DPAPI-encrypted snapshot atomically", async () => {
  if (Deno.build.os !== "windows") return;
  const root = await Deno.makeTempDir({ prefix: "okura-session-vault-test-" });
  const vault = new FileSessionVault(root, new WindowsDPAPIProtector());
  const key = { provider: "amazon" as const, profile: "personal" };
  const first = snapshot("first-secret-cookie");
  const second = snapshot("second-secret-cookie");
  try {
    await vault.save(key, first);
    await vault.save(key, second);

    const files = [...Deno.readDirSync(root)];
    assertEquals(files.length, 1);
    assertStringIncludes(files[0]?.name ?? "", "amazon-");
    const encrypted = await Deno.readFile(join(root, files[0]?.name ?? ""));
    const visible = new TextDecoder().decode(encrypted);
    assertEquals(visible.includes("second-secret-cookie"), false);
    assertEquals(await vault.load(key), second);

    await vault.remove(key);
    assertEquals(await vault.load(key), undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

function snapshot(cookie: string): ProviderSessionSnapshot<"amazon"> {
  return {
    schemaVersion: 1,
    provider: "amazon",
    capturedAt: "2026-08-23T00:00:00.000Z",
    payload: { cookie },
  };
}
