import { readBytesLimited } from "../../http/body.ts";
import { JCBError } from "./errors.ts";

export const MAX_RESPONSE_BYTES = 4 << 20;

export async function readJCBHTML(response: Response): Promise<string> {
  const bytes = await readBytesLimited(
    response,
    MAX_RESPONSE_BYTES,
    (value) => new JCBError(`response exceeds ${value} bytes`),
  );
  const contentType = response.headers.get("Content-Type") ?? "";
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch (error) {
    throw new JCBError(`decode response as ${charset}`, { cause: error });
  }
}
