import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert/";
import { TwoCaptchaError, TwoCaptchaTurnstileSolver } from "./two_captcha.ts";

Deno.test("TwoCaptchaTurnstileSolver posts create and poll requests to a localhost API", async () => {
  const controller = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: controller.signal,
    onListen() {},
  }, async (request) => {
    assertEquals(request.method, "POST");
    assertEquals(request.headers.get("Content-Type"), "application/json");
    const body = JSON.parse(await request.text());
    const path = new URL(request.url).pathname;
    if (path === "/createTask") {
      assertEquals(body, {
        clientKey: "local-test-key",
        task: {
          type: "TurnstileTaskProxyless",
          websiteURL: "https://example.com/login",
          websiteKey: "site-key",
        },
      });
      return json({ errorId: 0, taskId: 7 });
    }
    assertEquals(path, "/getTaskResult");
    assertEquals(body, { clientKey: "local-test-key", taskId: 7 });
    return json({
      errorId: 0,
      status: "ready",
      solution: { token: "local-token", userAgent: "local-agent" },
    });
  });
  const address = server.addr as Deno.NetAddr;
  try {
    const solver = new TwoCaptchaTurnstileSolver({
      apiKey: "local-test-key",
      baseURL: `http://${address.hostname}:${address.port}`,
      pollIntervalMs: 0,
    });
    assertEquals(
      await solver.solve({
        pageURL: "https://example.com/login",
        siteKey: "site-key",
      }),
      { token: "local-token", userAgent: "local-agent" },
    );
  } finally {
    controller.abort();
    await server.finished;
  }
});

Deno.test("TwoCaptchaTurnstileSolver creates and polls a bounded Turnstile task", async () => {
  const requests: unknown[] = [];
  let polls = 0;
  const solver = new TwoCaptchaTurnstileSolver({
    apiKey: "test-api-key",
    pollIntervalMs: 0,
    maxPollAttempts: 3,
    fetch: (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) return Promise.resolve(json({ errorId: 0, taskId: 42 }));
      polls += 1;
      return Promise.resolve(
        polls === 1 ? json({ errorId: 0, status: "processing" }) : json({
          errorId: 0,
          status: "ready",
          solution: { token: "turnstile-token", userAgent: "solver-agent" },
        }),
      );
    },
  });

  const solution = await solver.solve({
    pageURL: "https://example.com/login",
    siteKey: "site-key",
    action: "login",
    cData: "c-data",
    chlPageData: "page-data",
  });

  assertEquals(solution, { token: "turnstile-token", userAgent: "solver-agent" });
  assertEquals(requests, [
    {
      clientKey: "test-api-key",
      task: {
        type: "TurnstileTaskProxyless",
        websiteURL: "https://example.com/login",
        websiteKey: "site-key",
        action: "login",
        data: "c-data",
        pagedata: "page-data",
      },
    },
    { clientKey: "test-api-key", taskId: 42 },
    { clientKey: "test-api-key", taskId: 42 },
  ]);
});

Deno.test("TwoCaptchaTurnstileSolver exposes service errors without secrets", async () => {
  const solver = new TwoCaptchaTurnstileSolver({
    apiKey: "do-not-leak",
    pollIntervalMs: 0,
    fetch: () =>
      Promise.resolve(json({
        errorId: 10,
        errorCode: "ERROR_ZERO_BALANCE",
        errorDescription: "sensitive upstream detail",
      })),
  });

  const error = await assertRejects(
    () => solver.solve({ pageURL: "https://example.com/", siteKey: "site-key" }),
    TwoCaptchaError,
    "ERROR_ZERO_BALANCE",
  );
  assertEquals(error.code, "ERROR_ZERO_BALANCE");
  assertEquals(error.message.includes("do-not-leak"), false);
  assertEquals(error.message.includes("sensitive upstream detail"), false);
});

Deno.test("TwoCaptchaTurnstileSolver rejects malformed ready responses", async () => {
  let request = 0;
  const solver = new TwoCaptchaTurnstileSolver({
    apiKey: "test-key",
    pollIntervalMs: 0,
    fetch: () =>
      Promise.resolve(
        request++ === 0
          ? json({ errorId: 0, taskId: 1 })
          : json({ errorId: 0, status: "ready", solution: { token: "value" } }),
      ),
  });

  await assertRejects(
    () => solver.solve({ pageURL: "https://example.com/", siteKey: "site-key" }),
    TwoCaptchaError,
    "invalid User-Agent",
  );
});

Deno.test("TwoCaptchaTurnstileSolver stops after the configured poll limit", async () => {
  let request = 0;
  const solver = new TwoCaptchaTurnstileSolver({
    apiKey: "test-key",
    pollIntervalMs: 0,
    maxPollAttempts: 2,
    fetch: () =>
      Promise.resolve(
        request++ === 0
          ? json({ errorId: 0, taskId: 1 })
          : json({ errorId: 0, status: "processing" }),
      ),
  });

  await assertRejects(
    () => solver.solve({ pageURL: "https://example.com/", siteKey: "site-key" }),
    TwoCaptchaError,
    "within 2 poll attempts",
  );
  assertEquals(request, 3);
});

Deno.test("TwoCaptchaTurnstileSolver preserves abort reasons while waiting", async () => {
  const reason = new DOMException("stop", "AbortError");
  const controller = new AbortController();
  const solver = new TwoCaptchaTurnstileSolver({
    apiKey: "test-key",
    pollIntervalMs: 60_000,
    fetch: () => Promise.resolve(json({ errorId: 0, taskId: 1 })),
  });
  const pending = solver.solve(
    { pageURL: "https://example.com/", siteKey: "site-key" },
    { signal: controller.signal },
  );
  controller.abort(reason);

  assertStrictEquals(await pending.catch((error) => error), reason);
});

Deno.test("TwoCaptchaTurnstileSolver bounds a stalled API request with its own timeout", async () => {
  const solver = new TwoCaptchaTurnstileSolver({
    apiKey: "test-key",
    timeoutMs: 5,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  });

  const error = await assertRejects(
    () => solver.solve({ pageURL: "https://example.com/", siteKey: "site-key" }),
    TwoCaptchaError,
    "timed out",
  );
  assertEquals(error.operation, "create");
});

Deno.test("TwoCaptchaTurnstileSolver validates configuration and challenge fields", () => {
  assertThrows(() => new TwoCaptchaTurnstileSolver({ apiKey: "" }), TypeError);
  const solver = new TwoCaptchaTurnstileSolver({ apiKey: "test-key" });
  assertRejects(
    () => solver.solve({ pageURL: "file:///tmp/page", siteKey: "site-key" }),
    TypeError,
    "HTTP(S)",
  );
});

Deno.test("TwoCaptchaTurnstileSolver resolves a lazy API key only when solving", async () => {
  let reads = 0;
  const solver = new TwoCaptchaTurnstileSolver({
    apiKey: () => {
      reads += 1;
      return "lazy-key";
    },
    fetch: () => Promise.resolve(json({ errorId: 0, taskId: 1 })),
    pollIntervalMs: 0,
    maxPollAttempts: 1,
  });
  assertEquals(reads, 0);
  await assertRejects(
    () => solver.solve({ pageURL: "https://example.com/", siteKey: "site-key" }),
    TwoCaptchaError,
  );
  assertEquals(reads, 1);
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
