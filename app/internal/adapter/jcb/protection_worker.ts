import { executeProtection } from "./protection_runtime.js";

interface WorkerRequest {
  input: { userID: string; password: string; userAgent: string };
  loginURL: string;
  initURL: string;
  asyncURL: string;
  initSource: string;
  asyncSource: string;
  cookieHeader: string;
}

interface WorkerResult {
  action: string;
  body: string;
  cookieUpdates: string[];
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const result = await executeProtection(event.data) as WorkerResult;
    self.postMessage({ type: "result", result });
  } catch {
    self.postMessage({ type: "error" });
  }
};
