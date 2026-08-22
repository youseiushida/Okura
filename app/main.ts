import { runCLI } from "./internal/cli/main.ts";

if (import.meta.main) {
  try {
    Deno.exitCode = await runCLI(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
