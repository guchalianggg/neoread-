// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import { useAnnotationUpdates } from "./useAnnotationUpdates";
vi.mock("@neoread/api", () => ({
  api: { annotationStream: vi.fn(), annotations: vi.fn(async () => []) },
  reportDiagnostic: vi.fn(),
}));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("subscribes once per document, reloads on revisions and catches missed updates after reconnect", async () => {
  vi.useFakeTimers();
  const connections: {
    receive: (revision: string) => void;
    fail: (error: Error) => void;
    signal: AbortSignal;
  }[] = [];
  vi.mocked(api.annotationStream).mockImplementation(
    (_id, signal, receive) =>
      new Promise<void>((resolve, reject) => {
        connections.push({ receive, fail: reject, signal });
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  const update = vi.fn(),
    reset = vi.fn();
  function Fixture({ chapter }: { chapter: number }) {
    useAnnotationUpdates("doc", update, reset);
    return <span>{chapter}</span>;
  }
  const root = createRoot(document.createElement("div"));
  const tick = async (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  try {
    await act(async () => root.render(<Fixture chapter={1} />));
    await act(async () => connections[0].receive("initial"));
    await tick(50);
    expect(api.annotations).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Fixture chapter={2} />));
    await tick(50);
    expect(api.annotationStream).toHaveBeenCalledTimes(1);
    expect(api.annotations).toHaveBeenCalledTimes(1);
    // Completion elsewhere arrives without a chapter snapshot. A burst is coalesced.
    await act(async () => {
      connections[0].receive("changed1");
      connections[0].receive("changed2");
    });
    await tick(50);
    expect(api.annotations).toHaveBeenCalledTimes(2);
    await act(async () => connections[0].fail(new Error("disconnect")));
    await tick(500);
    await act(async () => connections[1].receive("changed2"));
    await tick(50);
    expect(api.annotations).toHaveBeenCalledTimes(2);
    await act(async () => connections[1].fail(new Error("disconnect")));
    await tick(500);
    await act(async () => connections[2].receive("changed-offline"));
    await tick(50);
    expect(api.annotations).toHaveBeenCalledTimes(3);
    // A failed read must not mark the revision as loaded.
    vi.mocked(api.annotations).mockRejectedValueOnce(
      new Error("temporary failure"),
    );
    await act(async () => connections[2].receive("retry"));
    await tick(50);
    await tick(500);
    expect(api.annotations).toHaveBeenCalledTimes(5);
    expect(update).toHaveBeenCalledTimes(4);
  } finally {
    await act(async () => root.unmount());
  }
  expect(connections[2].signal.aborted).toBe(true);
  await tick(10000);
  expect(api.annotationStream).toHaveBeenCalledTimes(3);
});

it("serializes reloads and discards a response superseded by a newer revision", async () => {
  vi.useFakeTimers();
  let receive!: (revision: string) => void;
  vi.mocked(api.annotationStream).mockImplementation(
    (_id, signal, callback) =>
      new Promise<void>((resolve) => {
        receive = callback;
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  let finish!: (items: []) => void;
  vi.mocked(api.annotations)
    .mockResolvedValue([])
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const update = vi.fn();
  function Fixture() {
    useAnnotationUpdates("doc", update, () => {});
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Fixture />));
    await act(async () => receive("old"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    await act(async () => receive("new"));
    expect(api.annotations).toHaveBeenCalledTimes(1);
    await act(async () => finish([]));
    expect(update).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(api.annotations).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
