import { requestInterceptor } from "jsdom";
import { appendHidden, fieldValue, findForm, formBody, setField } from "./forms.ts";
import { AMAZON_USER_AGENT, renderAmazonPage, waitFor } from "./runtime.ts";

interface RunRequest {
  kind: "claim" | "password";
  html: string;
  url: string;
  value: string;
}

interface ResourceResponse {
  type: "resource-response";
  id: number;
  ok: boolean;
  bytes?: ArrayBuffer;
}

let nextResourceID = 1;
const pendingResources = new Map<
  number,
  { resolve: (value: Response) => void; reject: (reason: Error) => void }
>();

self.addEventListener("message", async (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (isResourceResponse(message)) {
    const pending = pendingResources.get(message.id);
    if (pending === undefined) return;
    pendingResources.delete(message.id);
    if (!message.ok || message.bytes === undefined) {
      pending.reject(new Error("Amazon script resource was rejected"));
    } else {
      pending.resolve(
        new Response(message.bytes, {
          headers: { "Content-Type": "application/javascript; charset=utf-8" },
        }),
      );
    }
    return;
  }
  if (!isRecord(message) || message.type !== "run" || !isRunRequest(message.request)) return;
  try {
    const result = await execute(message.request);
    self.postMessage({ type: "result", result });
  } catch {
    self.postMessage({ type: "error" });
  }
});

async function execute(request: RunRequest): Promise<{ action: string; body: string }> {
  const dom = await renderAmazonPage(request.html, request.url, {
    userAgent: AMAZON_USER_AGENT,
    interceptors: [
      requestInterceptor((_resourceRequest, { element }) => {
        if (element?.localName !== "script") {
          return new Response(null, { status: 403 });
        }
        const id = nextResourceID++;
        return new Promise<Response>((resolve, reject) => {
          pendingResources.set(id, { resolve, reject });
          self.postMessage({ type: "resource-request", id, url: _resourceRequest.url });
        });
      }),
    ],
  });
  try {
    const fieldName = request.kind === "claim" ? "email" : "password";
    const form = findForm(dom.window.document, fieldName);
    if (form === undefined) throw new Error("Amazon login form was not found");
    const input = setField(form, fieldName, request.value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    if (request.kind === "claim") {
      form.dispatchEvent(
        new dom.window.SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
    }
    await waitFor(
      () => fieldValue(form, "metadata1").length > 100,
      15_000,
      "Amazon did not generate login metadata",
    );
    if (request.kind === "password") appendHidden(form, "encryptedPasswordExpected", "");
    const replacements: Record<string, string> = request.kind === "claim"
      ? { email: request.value, claimType: "email" }
      : {};
    return { action: form.action, body: formBody(form, replacements).toString() };
  } finally {
    dom.window.close();
  }
}

function isRunRequest(value: unknown): value is RunRequest {
  return isRecord(value) && (value.kind === "claim" || value.kind === "password") &&
    typeof value.html === "string" && typeof value.url === "string" &&
    typeof value.value === "string";
}

function isResourceResponse(value: unknown): value is ResourceResponse {
  return isRecord(value) && value.type === "resource-response" &&
    typeof value.id === "number" && typeof value.ok === "boolean" &&
    (value.bytes === undefined || value.bytes instanceof ArrayBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
