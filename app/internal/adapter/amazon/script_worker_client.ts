import { UnexpectedPageError } from "./errors.ts";
import { readBytesLimited } from "../../http/body.ts";
import { fileURLToPath } from "node:url";
import { AMAZON_USER_AGENT } from "./runtime.ts";

const ALLOWED_SCRIPT_HOSTS = new Set([
  "www.amazon.co.jp",
  "m.media-amazon.com",
  "images-fe.ssl-images-amazon.com",
  "images-na.ssl-images-amazon.com",
]);
const MAX_SCRIPT_RESOURCES = 64;
const MAX_SCRIPT_BYTES = 4 << 20;
const MAX_TOTAL_SCRIPT_BYTES = 16 << 20;
const SCRIPT_TIMEOUT_MS = 45_000;
const JSDOM_STYLESHEET_PATH = fileURLToPath(
  new URL("./jsdom/browser/default-stylesheet.css", import.meta.resolve("jsdom")),
);

export interface AmazonScriptRequest {
  kind: "claim" | "password";
  html: string;
  url: string;
  value: string;
}

export interface AmazonScriptResult {
  action: string;
  body: string;
}

export function executeAmazonScriptsIsolated(
  request: AmazonScriptRequest,
  signal?: AbortSignal,
): Promise<AmazonScriptResult> {
  signal?.throwIfAborted();
  const worker = new Worker(new URL("./script_worker.ts", import.meta.url).href, {
    type: "module",
    deno: {
      permissions: {
        env: ["JEST_WORKER_ID", "UNDICI_NO_WASM_SIMD"],
        read: [JSDOM_STYLESHEET_PATH],
      },
    },
  });
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () =>
      timeoutController.abort(
        new DOMException("Amazon script worker timed out", "TimeoutError"),
      ),
    SCRIPT_TIMEOUT_MS,
  );
  const workerSignal = signal === undefined
    ? timeoutController.signal
    : AbortSignal.any([signal, timeoutController.signal]);
  return new Promise((resolve, reject) => {
    const resourceAbort = new AbortController();
    let settled = false;
    let resourceCount = 0;
    let totalResourceBytes = 0;
    let resourceFailure: Error | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      workerSignal.removeEventListener("abort", onAbort);
      resourceAbort.abort();
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(workerSignal.reason));
    workerSignal.addEventListener("abort", onAbort, { once: true });
    if (workerSignal.aborted) {
      onAbort();
      return;
    }
    worker.onerror = (event) => {
      event.preventDefault();
      finish(() =>
        reject(resourceFailure ?? new UnexpectedPageError("Amazon script worker failed"))
      );
    };
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (isResourceRequest(message)) {
        resourceCount += 1;
        if (resourceCount > MAX_SCRIPT_RESOURCES) {
          resourceFailure = new UnexpectedPageError("Amazon requested too many script resources");
          worker.postMessage({ type: "resource-response", id: message.id, ok: false });
          return;
        }
        fetchScriptResource(message.url, request.url, resourceAbort.signal).then((bytes) => {
          if (settled) return;
          totalResourceBytes += bytes.byteLength;
          if (totalResourceBytes > MAX_TOTAL_SCRIPT_BYTES) {
            throw new UnexpectedPageError("Amazon script resources exceed the total size limit");
          }
          worker.postMessage(
            { type: "resource-response", id: message.id, ok: true, bytes: bytes.buffer },
            [bytes.buffer],
          );
        }).catch((error) => {
          if (settled) return;
          resourceFailure = error instanceof Error ? error : new Error(String(error));
          worker.postMessage({ type: "resource-response", id: message.id, ok: false });
        });
        return;
      }
      const result = isRecord(message) ? message.result : undefined;
      if (!isRecord(message) || message.type !== "result" || !isScriptResult(result)) {
        finish(() =>
          reject(
            resourceFailure ??
              new UnexpectedPageError("Amazon script worker returned invalid data"),
          )
        );
        return;
      }
      finish(() => resolve(result));
    };
    worker.postMessage({ type: "run", request });
  });
}

async function fetchScriptResource(
  value: string,
  referer: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let url = validatedScriptURL(value);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      signal,
      headers: {
        Accept: "application/javascript,text/javascript,*/*;q=0.8",
        Referer: referer,
        "User-Agent": AMAZON_USER_AGENT,
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      if (location === null || redirects === 5) {
        throw new UnexpectedPageError("Amazon script redirect was invalid");
      }
      await response.body?.cancel();
      url = validatedScriptURL(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new UnexpectedPageError(`Amazon script returned HTTP ${response.status}`);
    }
    return await readBytesLimited(
      response,
      MAX_SCRIPT_BYTES,
      (limit) => new UnexpectedPageError(`Amazon script exceeds ${limit} bytes`),
    );
  }
  throw new UnexpectedPageError("Amazon script redirected too many times");
}

function validatedScriptURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !ALLOWED_SCRIPT_HOSTS.has(url.hostname)) {
    throw new UnexpectedPageError("Amazon requested a script from an unapproved host");
  }
  return url;
}

function isResourceRequest(value: unknown): value is { id: number; url: string } {
  return isRecord(value) && value.type === "resource-request" &&
    Number.isSafeInteger(value.id) && typeof value.url === "string" && value.url.length <= 4096;
}

function isScriptResult(value: unknown): value is AmazonScriptResult {
  return isRecord(value) && typeof value.action === "string" && value.action.length <= 4096 &&
    typeof value.body === "string" && value.body.length <= 2 << 20;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
