export function usage(): string {
  return `Okura

Usage:
  okura.exe jcb fetch --from YYYY-MM-DD --to YYYY-MM-DD [options]
  okura.exe amazon fetch --from YYYY-MM-DD --to YYYY-MM-DD [options]
  okura.exe moneyforward fetch --from YYYY-MM-DD --to YYYY-MM-DD [options]
  okura.exe PROVIDER session remove [--profile NAME]

Development:
  deno task jcb -- --from YYYY-MM-DD --to YYYY-MM-DD [options]
  deno task amazon -- --from YYYY-MM-DD --to YYYY-MM-DD [options]
  deno task moneyforward -- --from YYYY-MM-DD --to YYYY-MM-DD [options]

Options:
  --wallet-id ID       Source wallet ID for JCB/Amazon (default: adapter name)
  --profile NAME       Saved login profile (default: default)
  --reauth             Remove the saved session and log in again
  --from DATE          First date to fetch (inclusive)
  --to DATE            Last date to fetch (inclusive)
  --format table|json  Output format (default: table)

Credentials:
  Enter interactively, or set JCB_USER_ID/JCB_PASSWORD or
  AMAZON_EMAIL/AMAZON_PASSWORD or
  MONEYFORWARD_EMAIL/MONEYFORWARD_PASSWORD.`;
}
