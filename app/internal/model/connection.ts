export type ConnectionID = string;

/**
 * 1つのProviderへ保存された、利用者が明示的に選ぶ接続単位。
 *
 * 同じProviderでもpersonal/businessなどのprofileごとに分離する。
 */
export interface ProviderConnection<Provider extends string = string> {
  readonly id: ConnectionID;
  readonly provider: Provider;
  readonly profile: string;
}

export function createProviderConnection<Provider extends string>(
  provider: Provider,
  profile: string,
): ProviderConnection<Provider> {
  if (!/^[a-z][a-z0-9-]*$/.test(provider)) {
    throw new TypeError("connection provider is invalid");
  }
  const normalizedProfile = profile.trim();
  if (
    normalizedProfile === "" || normalizedProfile.length > 200 ||
    hasControlCharacter(normalizedProfile)
  ) {
    throw new TypeError("connection profile is invalid");
  }
  return {
    id: `${provider}/${encodeURIComponent(normalizedProfile)}`,
    provider,
    profile: normalizedProfile,
  };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function scopedID(connectionID: ConnectionID, kind: string, localID: string): string {
  if (connectionID.trim() === "") throw new TypeError("connection ID is required");
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new TypeError("identity kind is invalid");
  if (localID.trim() === "") throw new TypeError("local identity is required");
  return `${connectionID}:${kind}:${localID}`;
}
