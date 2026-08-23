export function usage(): string {
  const executable = Deno.build.os === "windows" ? "okura.exe" : "okura";
  return `Okura

Usage:
  ${executable} jcb fetch --from YYYY-MM-DD --to YYYY-MM-DD [options]
  ${executable} amazon fetch --from YYYY-MM-DD --to YYYY-MM-DD [options]
  ${executable} moneyforward fetch --from YYYY-MM-DD --to YYYY-MM-DD [options]
  ${executable} PROVIDER session remove [--profile NAME]
  ${executable} PROVIDER credentials remove [--profile NAME]

Development:
  deno task start:windows -- PROVIDER fetch [options]
  deno task start:macos -- PROVIDER fetch [options]
  deno task start:linux -- PROVIDER fetch [options]

Options:
  --wallet-id ID       Source wallet ID for JCB/Amazon (default: adapter name)
  --profile NAME       Saved login profile (default: default)
  --reauth             Remove the saved session and log in again
  --save-credentials   Save ID/password after a successful new login
  --from DATE          First date to fetch (inclusive)
  --to DATE            Last date to fetch (inclusive)
  --format table|json  Output format (default: table)

Credentials:
  Resolution order: environment, OS credential store, interactive input.
  Enter interactively, or set JCB_USER_ID/JCB_PASSWORD or
  AMAZON_EMAIL/AMAZON_PASSWORD or
  MONEYFORWARD_EMAIL/MONEYFORWARD_PASSWORD.
  OTP and external approval responses are never saved.`;
}
