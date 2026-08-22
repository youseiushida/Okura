import { assertEquals, assertRejects } from "@std/assert/";
import { type Fetcher, HttpSession } from "./session.ts";

Deno.test("HttpSession rejects a cross-origin 307 before forwarding secrets", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: Fetcher = (input, init) => {
    requests.push({ url: String(input), init });
    return Promise.resolve(
      new Response(null, {
        status: 307,
        headers: { Location: "https://other.example/collect" },
      }),
    );
  };
  const session = new HttpSession(fetcher);

  await assertRejects(
    () =>
      session.request("https://login.example/signin", {
        method: "POST",
        body: "password=secret",
        headers: { Authorization: "Bearer secret" },
      }),
    Error,
    "cross-origin redirect",
  );
  assertEquals(requests.length, 1);
});

Deno.test("HttpSession strips sensitive headers from a cross-origin POST-to-GET redirect", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: Fetcher = (input, init) => {
    requests.push({ url: String(input), init });
    if (requests.length === 1) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: "https://other.example/landing" },
        }),
      );
    }
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
  const session = new HttpSession(fetcher);

  await session.request("https://login.example/signin", {
    method: "POST",
    body: "password=secret",
    headers: {
      Authorization: "Bearer secret",
      "Proxy-Authorization": "Basic secret",
      Origin: "https://login.example",
      Referer: "https://login.example/private",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  assertEquals(requests.length, 2);
  assertEquals(requests[1]?.url, "https://other.example/landing");
  assertEquals(requests[1]?.init?.method, "GET");
  assertEquals(requests[1]?.init?.body, undefined);
  const headers = new Headers(requests[1]?.init?.headers);
  for (
    const name of ["Authorization", "Proxy-Authorization", "Origin", "Referer", "Content-Type"]
  ) {
    assertEquals(headers.has(name), false);
  }
});

Deno.test("HttpSession preserves a same-origin 307 request", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: Fetcher = (input, init) => {
    requests.push({ url: String(input), init });
    if (requests.length === 1) {
      return Promise.resolve(
        new Response(null, {
          status: 307,
          headers: { Location: "/continue" },
        }),
      );
    }
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
  const session = new HttpSession(fetcher);

  await session.request("https://login.example/signin", {
    method: "POST",
    body: "password=secret",
    headers: { Authorization: "Bearer secret" },
  });

  assertEquals(requests[1]?.url, "https://login.example/continue");
  assertEquals(requests[1]?.init?.method, "POST");
  assertEquals(requests[1]?.init?.body, "password=secret");
  assertEquals(new Headers(requests[1]?.init?.headers).get("Authorization"), "Bearer secret");
});

Deno.test("HttpSession rejects an HTTPS downgrade", async () => {
  const session = new HttpSession(() =>
    Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { Location: "http://login.example/insecure" },
      }),
    )
  );
  await assertRejects(
    () => session.request("https://login.example/signin"),
    Error,
    "HTTPS redirect",
  );
});
