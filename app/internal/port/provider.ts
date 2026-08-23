/**
 * Providerの公開識別子。
 *
 * 対応Providerの一覧はcomposition rootが管理する。Port層では
 * 新しいAdapterを追加するたびに閉じたunionを変更しない。
 */
export type ProviderID = string;

export function isProviderID(value: unknown): value is ProviderID {
  return typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value);
}
