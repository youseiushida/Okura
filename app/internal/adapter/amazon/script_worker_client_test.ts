import { assert, assertEquals, assertRejects } from "@std/assert/";
import { executeAmazonScriptsIsolated } from "./script_worker_client.ts";

Deno.test("Amazon page scripts cannot read parent environment or files", async () => {
  const html = `<!doctype html><html><body>
    <form method="post" action="/ax/claim">
      <input name="email"><input name="metadata1">
    </form>
    <script>
      const metadata = document.querySelector('[name="metadata1"]');
      let deniedPermissions = 0;
      try {
        const escapedDeno = this.constructor.constructor("return Deno")();
        try { escapedDeno.env.get("PATH"); } catch { deniedPermissions += 1; }
        try { escapedDeno.readTextFileSync("deno.json"); } catch { deniedPermissions += 1; }
      } catch {
        deniedPermissions = 2;
      }
      metadata.value = (deniedPermissions === 2 ? "blocked-" : "leaked-") + "x".repeat(128);
    </script>
  </body></html>`;

  const result = await executeAmazonScriptsIsolated({
    kind: "claim",
    html,
    url: "https://www.amazon.co.jp/ap/signin",
    value: "test@example.invalid",
  }, AbortSignal.timeout(15_000));

  assertEquals(result.action, "https://www.amazon.co.jp/ax/claim");
  const body = new URLSearchParams(result.body);
  assertEquals(body.get("email"), "test@example.invalid");
  assert(body.get("metadata1")?.startsWith("blocked-"));
});

Deno.test("Amazon page script workers are terminated when aborted", async () => {
  const html = `<!doctype html><form action="/ax/claim">
    <input name="email"><input name="metadata1">
    <script>while (true) {}</script>
  </form>`;

  await assertRejects(
    () =>
      executeAmazonScriptsIsolated({
        kind: "claim",
        html,
        url: "https://www.amazon.co.jp/ap/signin",
        value: "test@example.invalid",
      }, AbortSignal.timeout(250)),
    DOMException,
  );
});
