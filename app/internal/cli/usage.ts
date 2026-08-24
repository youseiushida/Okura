export function usage(): string {
  const executable = Deno.build.os === "windows" ? "okura.exe" : "okura";
  return `Okura

Usage:
  ${executable} jcb fetch --from YYYY-MM-DD --to YYYY-MM-DD [options]
  ${executable} amazon fetch --from YYYY-MM-DD --to YYYY-MM-DD [options]
  ${executable} moneyforward fetch --from YYYY-MM-DD --to YYYY-MM-DD [options]
  ${executable} yucho-debit fetch --from YYYY-MM-DD --to YYYY-MM-DD [options]
  ${executable} PROVIDER session remove [--profile NAME]
  ${executable} PROVIDER credentials remove [--profile NAME]
  ${executable} solver 2captcha configure
  ${executable} solver 2captcha remove

Development:
  deno task start:windows -- PROVIDER fetch [options]
  deno task start:macos -- PROVIDER fetch [options]
  deno task start:linux -- PROVIDER fetch [options]

Options:
  --wallet-id ID       Source wallet ID for JCB/Amazon/Yucho Debit (default: adapter name)
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
  YUCHO_DEBIT_USER_ID/YUCHO_DEBIT_PASSWORD are used for a new Yucho Debit login.
  A new login resolves the shared 2Captcha key from TWOCAPTCHA_API_KEY, then the
  OS credential store. A valid saved session does not read either source.
  Environment keys are never saved automatically; use the configure command above.
  OTP and external approval responses are never saved.`;
}
