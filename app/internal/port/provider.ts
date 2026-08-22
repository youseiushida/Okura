export const PROVIDER_IDS = [
  "amazon",
  "jcb",
  "moneyforward",
] as const;

export type ProviderID = typeof PROVIDER_IDS[number];

export function isProviderID(value: unknown): value is ProviderID {
  return typeof value === "string" &&
    (PROVIDER_IDS as readonly string[]).includes(value);
}
