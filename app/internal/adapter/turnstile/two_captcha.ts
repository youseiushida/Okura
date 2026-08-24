import { readTextLimited } from "../../http/body.ts";
import type { Fetcher } from "../../http/session.ts";
import type {
  TurnstileChallenge,
  TurnstileSolution,
  TurnstileSolverOptions,
  TurnstileSolverPort,
} from "../../port/turnstile_solver.ts";

const DEFAULT_BASE_URL = "https://api.2captcha.com";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 24;
const DEFAULT_TIMEOUT_MS = 150_000;
const MAX_RESPONSE_BYTES = 64 << 10;
const MAX_API_KEY_LENGTH = 256;
const MAX_FIELD_LENGTH = 16 << 10;

export class TwoCaptchaError extends Error {
  readonly operation: "create" | "poll";
  readonly code?: string;

  constructor(
    operation: "create" | "poll",
    message: string,
    options: ErrorOptions & { code?: string } = {},
  ) {
    super(message, options);
    this.name = "TwoCaptchaError";
    this.operation = operation;
    this.code = options.code;
  }
}

export interface TwoCaptchaTurnstileSolverConfig {
  readonly apiKey: string | ((options?: TurnstileSolverOptions) => string | Promise<string>);
  readonly baseURL?: string;
  readonly fetch?: Fetcher;
  readonly pollIntervalMs?: number;
  readonly maxPollAttempts?: number;
  readonly timeoutMs?: number;
}

export class TwoCaptchaTurnstileSolver implements TurnstileSolverPort {
  readonly #apiKey: (options?: TurnstileSolverOptions) => string | Promise<string>;
  readonly #baseURL: URL;
  readonly #fetch: Fetcher;
  readonly #pollIntervalMs: number;
  readonly #maxPollAttempts: number;
  readonly #timeoutMs: number;

  constructor(config: TwoCaptchaTurnstileSolverConfig) {
    if (typeof config.apiKey === "function") {
      this.#apiKey = config.apiKey;
    } else {
      const apiKey = validateSecret(config.apiKey, "2Captcha API key", MAX_API_KEY_LENGTH);
      this.#apiKey = () => apiKey;
    }
    this.#baseURL = parseBaseURL(config.baseURL ?? DEFAULT_BASE_URL);
    this.#fetch = config.fetch ?? fetch;
    this.#pollIntervalMs = nonNegativeInteger(
      config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "2Captcha poll interval",
    );
    this.#maxPollAttempts = positiveInteger(
      config.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS,
      "2Captcha maximum poll attempts",
    );
    this.#timeoutMs = positiveInteger(
      config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "2Captcha timeout",
    );
  }

  async solve(
    challenge: TurnstileChallenge,
    options: TurnstileSolverOptions = {},
  ): Promise<TurnstileSolution> {
    options.signal?.throwIfAborted();
    const timeout = timeoutSignal(this.#timeoutMs, options.signal);
    let operation: "create" | "poll" = "create";
    try {
      const request = parseChallenge(challenge);
      const apiKey = validateSecret(
        await this.#apiKey({ signal: timeout.signal }),
        "2Captcha API key",
        MAX_API_KEY_LENGTH,
      );
      const created = await this.#post(
        "createTask",
        {
          clientKey: apiKey,
          task: {
            type: "TurnstileTaskProxyless",
            websiteURL: request.pageURL,
            websiteKey: request.siteKey,
            ...(request.action === undefined ? {} : { action: request.action }),
            ...(request.cData === undefined ? {} : { data: request.cData }),
            ...(request.chlPageData === undefined ? {} : { pagedata: request.chlPageData }),
          },
        },
        "create",
        timeout.signal,
      );
      const taskID = parseTaskID(created);
      operation = "poll";

      for (let attempt = 1; attempt <= this.#maxPollAttempts; attempt += 1) {
        await delay(this.#pollIntervalMs, timeout.signal);
        const result = await this.#post(
          "getTaskResult",
          {
            clientKey: apiKey,
            taskId: taskID,
          },
          "poll",
          timeout.signal,
        );
        const status = field(result, "status");
        if (status === "processing") continue;
        if (status !== "ready") {
          throw new TwoCaptchaError("poll", "2Captcha returned an unknown task status");
        }
        return parseSolution(result);
      }
      throw new TwoCaptchaError(
        "poll",
        `2Captcha task did not complete within ${this.#maxPollAttempts} poll attempts`,
      );
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (timeout.signal.aborted) {
        throw new TwoCaptchaError(operation, "2Captcha solve timed out", { cause: error });
      }
      throw error;
    } finally {
      timeout.dispose();
    }
  }

  async #post(
    path: "createTask" | "getTaskResult",
    payload: unknown,
    operation: "create" | "poll",
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const url = new URL(`/${path}`, this.#baseURL);
    const response = await this.#fetch(url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    signal?.throwIfAborted();
    const body = await readTextLimited(
      response,
      MAX_RESPONSE_BYTES,
      (limit) => new TwoCaptchaError(operation, `2Captcha response exceeds ${limit} bytes`),
    );
    if (!response.ok) {
      throw new TwoCaptchaError(operation, `2Captcha returned HTTP ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new TwoCaptchaError(operation, "2Captcha returned malformed JSON", { cause: error });
    }
    if (!isRecord(parsed)) {
      throw new TwoCaptchaError(operation, "2Captcha response is not an object");
    }
    const errorID = field(parsed, "errorId");
    if (!Number.isInteger(errorID) || (errorID as number) < 0) {
      throw new TwoCaptchaError(operation, "2Captcha response has an invalid error ID");
    }
    if (errorID !== 0) {
      const code = typeof parsed.errorCode === "string" && parsed.errorCode !== ""
        ? parsed.errorCode
        : undefined;
      throw new TwoCaptchaError(
        operation,
        code === undefined ? "2Captcha rejected the request" : `2Captcha error ${code}`,
        { code },
      );
    }
    return parsed;
  }
}

function parseChallenge(challenge: TurnstileChallenge): TurnstileChallenge {
  if (!isRecord(challenge)) throw new TypeError("Turnstile challenge must be an object");
  const pageURL = new URL(requiredField(challenge.pageURL, "Turnstile page URL"));
  if (pageURL.protocol !== "https:" && pageURL.protocol !== "http:") {
    throw new TypeError("Turnstile page URL must use HTTP(S)");
  }
  if (pageURL.username !== "" || pageURL.password !== "") {
    throw new TypeError("Turnstile page URL must not contain credentials");
  }
  return {
    pageURL: pageURL.href,
    siteKey: requiredField(challenge.siteKey, "Turnstile site key"),
    ...optionalFields(challenge),
  };
}

function optionalFields(challenge: Record<string, unknown>): Pick<
  TurnstileChallenge,
  "action" | "cData" | "chlPageData"
> {
  const result: { action?: string; cData?: string; chlPageData?: string } = {};
  for (
    const [name, label] of [
      ["action", "Turnstile action"],
      ["cData", "Turnstile cData"],
      ["chlPageData", "Turnstile page data"],
    ] as const
  ) {
    const value = challenge[name];
    if (value !== undefined) result[name] = requiredField(value, label);
  }
  return result;
}

function parseTaskID(response: Record<string, unknown>): number {
  const value = field(response, "taskId");
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TwoCaptchaError("create", "2Captcha response has an invalid task ID");
  }
  return value as number;
}

function parseSolution(response: Record<string, unknown>): TurnstileSolution {
  const value = field(response, "solution");
  if (!isRecord(value)) {
    throw new TwoCaptchaError("poll", "2Captcha response has no solution object");
  }
  return {
    token: solutionField(value.token, "token", 32 << 10),
    userAgent: solutionField(value.userAgent, "User-Agent", 2 << 10),
  };
}

function parseBaseURL(value: string): URL {
  const result = new URL(value);
  if (
    (result.protocol !== "https:" && result.protocol !== "http:") ||
    result.username !== "" || result.password !== "" || result.search !== "" ||
    result.hash !== "" || result.pathname !== "/"
  ) {
    throw new TypeError("2Captcha base URL must contain only an HTTP(S) origin");
  }
  return result;
}

function validateSecret(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== "string" || value === "" || value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function requiredField(value: unknown, name: string): string {
  if (
    typeof value !== "string" || value === "" || value.length > MAX_FIELD_LENGTH ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function solutionField(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== "string" || value === "" || value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    throw new TwoCaptchaError("poll", `2Captcha solution has an invalid ${name}`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must not be negative`);
  }
  return value;
}

function field(value: Record<string, unknown>, name: string): unknown {
  return value[name];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(signal?.reason);
    }
  });
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abortFromParent, { once: true });
  if (parent?.aborted) abortFromParent();
  const timer = setTimeout(
    () => controller.abort(new DOMException("2Captcha solve timed out", "TimeoutError")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}
