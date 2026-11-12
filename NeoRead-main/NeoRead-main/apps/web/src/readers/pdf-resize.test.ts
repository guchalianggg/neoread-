// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { PDFViewport } from "./pdf-viewport";
import { PDFResizeObserver } from "./pdf-resize";

let notify: () => void;
let observer: PDFResizeObserver;
let group: HTMLDivElement;
let handle: HTMLDivElement;
let host: HTMLDivElement;
let width: number;
let scale: number;
const scales = vi.fn();
const commit = vi.fn();
function pointer(type: string, target: EventTarget = document) {
  const event = new MouseEvent(type, { bubbles: true, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  group = document.createElement("div");
  group.dataset.slot = "resizable-panel-group";
  handle = document.createElement("div");
  handle.dataset.slot = "resizable-handle";
  host = document.createElement("div");
  group.append(handle, host);
  document.body.append(group);
  width = 800;
  scale = 1.6;
  Object.defineProperties(host, {
    clientWidth: { get: () => width },
    clientHeight: { value: 600 },
  });
  const viewer = {
    currentPageNumber: 1,
    getPageView: () => undefined,
    get currentScale() {
      return scale;
    },
    updateScale: ({ scaleFactor }: { scaleFactor: number }) => {
      scale *= scaleFactor;
      scales(scale);
    },
  } as unknown as PDFViewer;
  const viewport = new PDFViewport(host, viewer);
  viewport.reset();
  observer = new PDFResizeObserver(
    host,
    () => {
      commit();
      viewport.resize(false, () => {});
    },
    () => viewport.cancelAnimation(),
  );
});
afterEach(() => {
  observer.disconnect();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("keeps the scale fixed even when dragging pauses, and scales once on release", async () => {
  pointer("pointerdown", handle);
  for (const next of [700, 600, 400]) {
    width = next;
    notify();
    await vi.advanceTimersByTimeAsync(500);
    expect(scale).toBe(1.6);
  }
  pointer("pointerup");
  await vi.advanceTimersByTimeAsync(32);
  expect(scales.mock.calls).toEqual([[0.8]]);
  expect(commit).toHaveBeenCalledTimes(1);
});
it("waits for sidebar transitions, including a reversal, to end", async () => {
  group.setAttribute("data-toggling", "");
  for (const next of [500, 450, 700]) {
    width = next;
    notify();
    await vi.advanceTimersByTimeAsync(100);
    expect(scales).not.toHaveBeenCalled();
  }
  group.removeAttribute("data-toggling");
  await vi.advanceTimersByTimeAsync(32);
  expect(scales.mock.calls).toEqual([[1.4]]);
});
it.each(["pointercancel", "blur"])(
  "finishes pending resize after %s",
  async (end) => {
    pointer("pointerdown", host);
    handle.setAttribute("data-separator", "active");
    width = 400;
    notify();
    if (end === "blur") window.dispatchEvent(new Event("blur"));
    else pointer(end);
    await vi.advanceTimersByTimeAsync(32);
    expect(scales.mock.calls).toEqual([[0.8]]);
  },
);
it("holds repeated keyboard resizing until keyup", async () => {
  for (const next of [700, 400]) {
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    width = next;
    notify();
    await vi.advanceTimersByTimeAsync(200);
  }
  expect(scales).not.toHaveBeenCalled();
  document.dispatchEvent(
    new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }),
  );
  await vi.advanceTimersByTimeAsync(32);
  expect(scales.mock.calls).toEqual([[0.8]]);
});
it("coalesces window resizes without depending on a transition event", async () => {
  for (const next of [700, 600, 400]) {
    width = next;
    notify();
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(scales).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(160);
  expect(scales.mock.calls).toEqual([[0.8]]);
});
it("does not wait on unrelated panel handles", async () => {
  const other = group.cloneNode(true) as Element;
  document.body.append(other);
  pointer("pointerdown", other.firstChild!);
  width = 400;
  notify();
  await vi.advanceTimersByTimeAsync(160);
  expect(scales.mock.calls).toEqual([[0.8]]);
});
it("cancels pending work when the reader closes", async () => {
  width = 400;
  notify();
  observer.disconnect();
  await vi.advanceTimersByTimeAsync(500);
  pointer("pointerup");
  expect(commit).not.toHaveBeenCalled();
});

it("waits for the library's actual drag state when the pointer targets an adjacent panel", async () => {
  pointer("pointerdown", host);
  handle.setAttribute("data-separator", "active");
  width = 400;
  notify();
  await vi.advanceTimersByTimeAsync(500);
  expect(scales).not.toHaveBeenCalled();
  pointer("pointerup");
  handle.setAttribute("data-separator", "hover");
  await vi.advanceTimersByTimeAsync(32);
  expect(scales.mock.calls).toEqual([[0.8]]);
});
it("cancels a queued animation frame and removes listeners on disposal", async () => {
  const removed = vi.spyOn(document, "removeEventListener");
  const frame = vi.spyOn(globalThis, "requestAnimationFrame");
  width = 400;
  notify();
  await vi.advanceTimersByTimeAsync(120);
  expect(frame).toHaveBeenCalled();
  observer.disconnect();
  await vi.advanceTimersByTimeAsync(32);
  expect(commit).not.toHaveBeenCalled();
  for (const type of [
    "pointerdown",
    "pointerup",
    "pointercancel",
    "keydown",
    "keyup",
  ])
    expect(removed).toHaveBeenCalledWith(type, expect.any(Function), true);
  removed.mockRestore();
  frame.mockRestore();
});
