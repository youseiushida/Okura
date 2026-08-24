export type SizeLimitErrorFactory = (limit: number) => Error;
export type CharsetDecodeErrorFactory = (charset: string, cause: unknown) => Error;

export async function readBytesLimited(
  response: Response,
  limit: number,
  createError: SizeLimitErrorFactory = (value) => new Error(`response exceeds ${value} bytes`),
): Promise<Uint8Array> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw createError(limit);
    }
  }

  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        throw createError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readTextLimited(
  response: Response,
  limit: number,
  createError?: SizeLimitErrorFactory,
): Promise<string> {
  return new TextDecoder().decode(await readBytesLimited(response, limit, createError));
}

export async function readTextLimitedWithCharset(
  response: Response,
  limit: number,
  createError?: SizeLimitErrorFactory,
  createDecodeError: CharsetDecodeErrorFactory = (charset, cause) =>
    new Error(`decode response as ${charset}`, { cause }),
): Promise<string> {
  const bytes = await readBytesLimited(response, limit, createError);
  const contentType = response.headers.get("Content-Type") ?? "";
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch (error) {
    throw createDecodeError(charset, error);
  }
}

export async function discardLimited(
  response: Response,
  limit: number,
  createError?: SizeLimitErrorFactory,
): Promise<void> {
  await readBytesLimited(response, limit, createError);
}
