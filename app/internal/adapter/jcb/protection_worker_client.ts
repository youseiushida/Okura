import { JCBError } from "./errors.ts";

export interface ProtectionWorkerRequest {
  input: { userID: string; password: string; userAgent: string };
  loginURL: string;
  initURL: string;
  asyncURL: string;
  initSource: string;
  asyncSource: string;
  cookieHeader: string;
}

export interface ProtectionWorkerResult {
  action: string;
  body: string;
  cookieUpdates: string[];
}

export function executeProtectionIsolated(
  request: ProtectionWorkerRequest,
  signal: AbortSignal,
): Promise<ProtectionWorkerResult> {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./protection_worker.ts", import.meta.url).href, {
    type: "module",
    deno: { permissions: "none" },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => {
      event.preventDefault();
      finish(() => reject(new JCBError("MyJCB protection worker failed")));
    };
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      const result = isRecord(message) ? message.result : undefined;
      if (!isRecord(message) || message.type !== "result" || !isWorkerResult(result)) {
        finish(() => reject(new JCBError("MyJCB protection worker returned invalid data")));
        return;
      }
      finish(() => resolve(result));
    };
    worker.postMessage(request);
  });
}

function isWorkerResult(value: unknown): value is ProtectionWorkerResult {
  return isRecord(value) && typeof value.action === "string" && typeof value.body === "string" &&
    Array.isArray(value.cookieUpdates) &&
    value.cookieUpdates.length <= 100 &&
    value.cookieUpdates.every((item) => typeof item === "string" && item.length <= 4096);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
