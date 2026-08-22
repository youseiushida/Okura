import { JSDOM, type ResourcesOptions, VirtualConsole } from "jsdom";

export const AMAZON_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Edg/151.0.0.0 Mobile Safari/537.36";

export async function renderAmazonPage(
  html: string,
  url: string,
  resources: ResourcesOptions,
): Promise<JSDOM> {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(stripPassiveResources(html), {
    url,
    runScripts: "dangerously",
    resources,
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window.navigator, "hardwareConcurrency", { value: 8 });
      Object.defineProperty(window.navigator, "deviceMemory", { value: 16 });
      window.matchMedia ??= () => ({ matches: false }) as MediaQueryList;
      window.HTMLCanvasElement.prototype.getContext = () => null;
      Object.defineProperty(window.crypto, "subtle", { value: globalThis.crypto.subtle });
      Object.defineProperty(window, "TextEncoder", { value: globalThis.TextEncoder });
      Object.defineProperty(window, "TextDecoder", { value: globalThis.TextDecoder });
    },
  });
  try {
    await waitFor(() => dom.window.document.readyState === "complete", 20_000);
    return dom;
  } catch (error) {
    dom.window.close();
    throw error;
  }
}

export function parseAmazonPage(html: string, url: string): JSDOM {
  return new JSDOM(html, { url });
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  message = "timed out waiting for an Amazon page script",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function stripPassiveResources(html: string): string {
  return html
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<(?:video|audio|object)\b[^>]*>[\s\S]*?<\/(?:video|audio|object)>/gi, "");
}
