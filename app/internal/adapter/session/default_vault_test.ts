import { assertEquals, assertThrows } from "@std/assert/";
import { sessionVaultRoot } from "./default_vault.ts";

Deno.test("sessionVaultRoot uses the Windows application data path", () => {
  const root = sessionVaultRoot(
    "windows",
    (name) => name === "LOCALAPPDATA" ? "C:\\Users\\test\\AppData\\Local" : undefined,
  );

  assertEquals(root, "C:\\Users\\test\\AppData\\Local\\Okura\\sessions\\aes-gcm-v1");
});

Deno.test("sessionVaultRoot uses the macOS Application Support directory", () => {
  assertEquals(
    sessionVaultRoot("darwin", (name) => name === "HOME" ? "/Users/test" : undefined),
    "/Users/test/Library/Application Support/Okura/sessions/aes-gcm-v1",
  );
});

Deno.test("sessionVaultRoot honors XDG_DATA_HOME on Linux", () => {
  assertEquals(
    sessionVaultRoot(
      "linux",
      (name) => name === "XDG_DATA_HOME" ? "/data/test" : undefined,
    ),
    "/data/test/Okura/sessions/aes-gcm-v1",
  );
});

Deno.test("sessionVaultRoot falls back to the Linux user data directory", () => {
  assertEquals(
    sessionVaultRoot("linux", (name) => name === "HOME" ? "/home/test" : undefined),
    "/home/test/.local/share/Okura/sessions/aes-gcm-v1",
  );
});

Deno.test("sessionVaultRoot fails when required platform paths are unavailable", () => {
  assertThrows(() => sessionVaultRoot("windows", () => undefined), Error, "LOCALAPPDATA");
  assertThrows(() => sessionVaultRoot("darwin", () => undefined), Error, "HOME");
  assertThrows(() => sessionVaultRoot("linux", () => undefined), Error, "HOME");
});
