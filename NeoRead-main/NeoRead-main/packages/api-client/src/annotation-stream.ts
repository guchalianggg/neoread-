// This stream contains revision tokens only, never publication text.
export async function consumeAnnotationStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onRevision: (revision: string) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  let buffer = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) throw new Error("批注连接中断");
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith(":")) continue;
        const lines = frame.split("\n");
        if (!lines.includes("event: revision"))
          throw new Error("批注事件格式无效");
        const revision: unknown = JSON.parse(
          lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n"),
        );
        if (typeof revision !== "string" || !/^[a-f0-9]{32}$/.test(revision))
          throw new Error("批注版本无效");
        onRevision(revision);
      }
      if (buffer.length > 4096) throw new Error("批注事件超出大小限制");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
