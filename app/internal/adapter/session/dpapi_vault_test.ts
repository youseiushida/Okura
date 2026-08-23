import { assertEquals, assertStringIncludes } from "@std/assert/";
import { join } from "node:path";
import { createProviderConnection } from "../../model/connection.ts";
import type { ProviderSessionSnapshot } from "../../port/authentication.ts";
import {
  bindLegacySnapshotToConnection,
  FileSessionVault,
  WindowsDPAPIProtector,
} from "./dpapi_vault.ts";

Deno.test("legacy DPAPI snapshot is bound to the selected connection", () => {
  const key = createProviderConnection("amazon", "personal");
  assertEquals(
    bindLegacySnapshotToConnection(
      { schemaVersion: 1, provider: "amazon", capturedAt: "2026-08-23T00:00:00Z", payload: {} },
      key,
    ),
    {
      schemaVersion: 1,
      provider: "amazon",
      connectionID: key.id,
      capturedAt: "2026-08-23T00:00:00Z",
      payload: {},
    },
  );
});

Deno.test("FileSessionVault persists an opaque DPAPI-encrypted snapshot atomically", async () => {
  if (Deno.build.os !== "windows") return;
  const root = await Deno.makeTempDir({ prefix: "okura-session-vault-test-" });
  const vault = new FileSessionVault(root, new WindowsDPAPIProtector());
  const key = createProviderConnection("amazon", "personal");
  const first = snapshot(key.id, "first-secret-cookie");
  const second = snapshot(key.id, "second-secret-cookie");
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

function snapshot(connectionID: string, cookie: string): ProviderSessionSnapshot<"amazon"> {
  return {
    schemaVersion: 1,
    provider: "amazon",
    connectionID,
    capturedAt: "2026-08-23T00:00:00.000Z",
    payload: { cookie },
  };
}
