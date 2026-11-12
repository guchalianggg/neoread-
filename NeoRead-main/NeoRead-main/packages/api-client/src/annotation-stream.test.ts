import { expect, it } from "vitest";
import { consumeAnnotationStream } from "./annotation-stream";
it("delivers fragmented revision frames live, ignores heartbeats and cancels its reader", async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      source = c;
    },
  });
  const abort = new AbortController();
  const revisions: string[] = [];
  const pending = consumeAnnotationStream(body, abort.signal, (revision) =>
    revisions.push(revision),
  );
  const revision = "a".repeat(32);
  const bytes = new TextEncoder().encode(
    `: keepalive\n\nevent: revision\ndata: "${revision}"\n\n`,
  );
  for (const byte of bytes) source.enqueue(new Uint8Array([byte]));
  for (let i = 0; i < bytes.length + 5; i++) await Promise.resolve();
  expect(revisions).toEqual([revision]);
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(body.locked).toBe(false);
});
it("rejects invalid revision tokens without dispatching them", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          'event: revision\ndata: {"unexpected":true}\n\n',
        ),
      );
    },
  });
  const revisions: string[] = [];
  await expect(
    consumeAnnotationStream(body, new AbortController().signal, (r) =>
      revisions.push(r),
    ),
  ).rejects.toThrow("批注版本无效");
  expect(revisions).toEqual([]);
  expect(body.locked).toBe(false);
});
