import { assertEquals, assertRejects } from "@std/assert/";
import { readBytesLimited, readTextLimitedWithCharset } from "./body.ts";

Deno.test("readBytesLimited cancels a streamed response at the size limit", async () => {
  let canceled = false;
  let index = 0;
  const chunks = [new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)];
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    }),
  );

  await assertRejects(() => readBytesLimited(response, 5), Error, "exceeds 5 bytes");
  assertEquals(canceled, true);
  assertEquals(index, 2);
});

Deno.test("readBytesLimited rejects Content-Length before pulling the body", async () => {
  let pulled = false;
  let canceled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        canceled = true;
      },
    }),
    { headers: { "Content-Length": "100" } },
  );

  await assertRejects(() => readBytesLimited(response, 5), Error, "exceeds 5 bytes");
  assertEquals(pulled, false);
  assertEquals(canceled, true);
});

Deno.test("readTextLimitedWithCharset decodes the declared legacy HTML charset", async () => {
  const response = new Response(
    new Uint8Array([0x83, 0x8d, 0x83, 0x4f, 0x83, 0x43, 0x83, 0x93]),
    { headers: { "Content-Type": "text/html;charset=Windows-31J" } },
  );
  assertEquals(await readTextLimitedWithCharset(response, 100), "ログイン");
});

Deno.test("readTextLimitedWithCharset rejects malformed legacy-charset bytes", async () => {
  const response = new Response(
    new Uint8Array([0x82]),
    { headers: { "Content-Type": "text/html;charset=Windows-31J" } },
  );
  let decodeErrorCalled = false;

  await assertRejects(
    () =>
      readTextLimitedWithCharset(
        response,
        100,
        undefined,
        (charset, cause) => {
          decodeErrorCalled = true;
          return new TypeError(`cannot decode ${charset}`, { cause });
        },
      ),
    TypeError,
    "Windows-31J",
  );
  assertEquals(decodeErrorCalled, true);
});

Deno.test("readTextLimitedWithCharset reports unsupported charsets through its error factory", async () => {
  const response = new Response("body", {
    headers: { "Content-Type": "text/html;charset=not-a-real-charset" },
  });
  await assertRejects(
    () =>
      readTextLimitedWithCharset(
        response,
        100,
        undefined,
        (charset, cause) => new TypeError(`cannot decode ${charset}`, { cause }),
      ),
    TypeError,
    "not-a-real-charset",
  );
});
