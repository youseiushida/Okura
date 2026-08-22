import { assertEquals, assertRejects } from "@std/assert/";
import { readBytesLimited } from "./body.ts";

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
