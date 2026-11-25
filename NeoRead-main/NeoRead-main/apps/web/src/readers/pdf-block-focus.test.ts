// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFBlock } from "@neoread/core";
const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("../motion", () => ({ reducedMotion: () => motion.reduced }));
vi.mock("pdfjs-dist", () => ({
  Util: { transform: (_a: number[], b: number[]) => b },
}));
import { PDFReadingNavigation } from "./pdf-navigation";
import { PDFViewport } from "./pdf-viewport";
import { PDFResizeObserver } from "./pdf-resize";
beforeEach(() => {
  motion.reduced = false;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  const host = document.createElement("div");
  const size = { width: 600, height: 600 };
  let scale = 1;
  Object.defineProperties(host, {
    clientWidth: { get: () => size.width },
    clientHeight: { get: () => size.height },
    scrollWidth: { value: 5000 },
    scrollHeight: { value: 10000 },
  });
  host.getBoundingClientRect = () =>
    new DOMRect(30, 50, size.width, size.height);
  const blocks: PDFBlock[] = [
    {
      id: "a",
      page: 1,
      label: "text",
      text: "A",
      bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.2 },
    },
    {
      id: "b",
      page: 1,
      label: "text",
      text: "B",
      bounds: { x: 0.1, y: 0.5, width: 0.8, height: 0.4 },
    },
    {
      id: "image",
      page: 2,
      label: "image",
      text: "",
      image: "figure.png",
      bounds: { x: 0.6, y: 0.2, width: 0.2, height: 0.7 },
    },
    {
      id: "footer",
      page: 2,
      label: "footer",
      text: "2",
      bounds: { x: 0.5, y: 0.95, width: 0.1, height: 0.02 },
    },
  ];
  const nodes = [0, 1].map((n) => {
    const node = document.createElement("div");
    node.getBoundingClientRect = () => {
      const inset = (axis: "x" | "y") =>
        host.classList.contains("pdf-block-reading")
          ? parseFloat(host.style.getPropertyValue(`--reading-inset-${axis}`))
          : 0;
      return new DOMRect(
        30 + inset("x") - host.scrollLeft,
        50 + inset("y") + n * 1300 * scale - host.scrollTop,
        1000 * scale,
        1200 * scale,
      );
    };
    return node;
  });
  const focus = vi.fn(),
    anchor = vi.fn();
  const page = vi.fn(
    async () =>
      ({ getViewport: () => ({ width: 750, height: 900 }) }) as PDFPageProxy,
  );
  const viewer = {
    currentPageNumber: 1,
    refresh: vi.fn(),
    get currentScale() {
      return scale;
    },
    set currentScaleValue(value: string) {
      scale = Number(value);
    },
    updateScale: vi.fn(({ scaleFactor }: { scaleFactor: number }) => {
      scale = Math.round(scale * scaleFactor * 100) / 100;
    }),
    getPageView: (i: number) => ({ div: nodes[i] }),
  } as unknown as PDFViewer;
  const nav = new PDFReadingNavigation(
    host,
    viewer,
    page,
    () => blocks,
    { location: vi.fn(), selection: vi.fn(), readingAnchor: anchor },
    focus,
  );
  const rect = (id: string) => {
    const block = blocks.find((b) => b.id === id)!;
    const r = nodes[block.page - 1].getBoundingClientRect();
    return new DOMRect(
      r.left + block.bounds.x * r.width,
      r.top + block.bounds.y * r.height,
      block.bounds.width * r.width,
      block.bounds.height * r.height,
    );
  };
  return {
    nav,
    host,
    size,
    viewer,
    page,
    blocks,
    focus,
    rect,
    anchor,
  };
}
async function finish(p: Promise<unknown>) {
  await vi.advanceTimersByTimeAsync(500);
  return p;
}
function centered(s: ReturnType<typeof setup>, id: string) {
  const r = s.rect(id),
    v = s.host.getBoundingClientRect();
  expect(r.left + r.width / 2).toBeCloseTo(v.left + v.width / 2);
  expect(r.top).toBeCloseTo(v.top + Math.max(0, (v.height - r.height) / 2));
}

function resizingFocus(fitWidth = false) {
  const s = setup();
  document.body.append(s.host);
  for (let i = 0; i < 2; i++) {
    const node = s.viewer.getPageView(i).div;
    node.className = "page";
    s.host.append(node);
  }
  s.viewer.currentScaleValue = "0.25";
  const viewport = new PDFViewport(s.host, s.viewer);
  viewport.reset();
  let resizing = false;
  s.viewer.updateScale = vi.fn(({ scaleFactor }) => {
    s.viewer.currentScaleValue = String(
      Math.round(s.viewer.currentScale * scaleFactor! * 100) / 100,
    );
    if (!resizing) viewport.scaleChanged();
  });
  let notify!: () => void;
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
  const adapt = vi.fn(() => s.nav.resizeViewport());
  const observer = new PDFResizeObserver(
    s.host,
    () => {
      resizing = true;
      try {
        viewport.resize(fitWidth, adapt, s.nav.isNavigating);
      } finally {
        resizing = false;
      }
    },
    () => viewport.cancelAnimation(),
  );
  return {
    ...s,
    notify: () => notify(),
    adapt,
    destroy() {
      observer.disconnect();
      s.nav.destroy();
      s.host.remove();
    },
  };
}

it.each([false, true])(
  "centers the focused block at the same scale after a height-only resize (fit width: %s)",
  async (fitWidth) => {
    const s = resizingFocus(fitWidth);
    try {
      const first = s.nav.focusBlock("a");
      await vi.advanceTimersByTimeAsync(16);
      s.size.height -= 6;
      s.notify();
      await vi.advanceTimersByTimeAsync(144);
      expect(s.adapt).not.toHaveBeenCalled();
      expect(s.viewer.currentScale).toBe(0.25);
      expect(await finish(first)).toBe(true);
      expect(s.viewer.currentScale).toBe(0.25);
      expect(s.viewer.updateScale).not.toHaveBeenCalled();
      centered(s, "a");
      expect(await finish(s.nav.focusBlock("a"))).toBe(true);
      expect(s.viewer.currentScale).toBe(0.25);
    } finally {
      s.destroy();
    }
  },
);

it("still interrupts focus and adapts to an actual panel width change", async () => {
  const s = resizingFocus();
  try {
    const pending = s.nav.focusBlock("a");
    await vi.advanceTimersByTimeAsync(80);
    s.size.width = 400;
    s.notify();
    expect(await finish(pending)).toBe(false);
    expect(s.adapt).toHaveBeenCalledOnce();
    const calls = vi.mocked(s.viewer.updateScale).mock.calls;
    expect(calls).toHaveLength(1);
    expect(s.viewer.currentScale).toBe(0.17);
  } finally {
    s.destroy();
  }
});
it("smoothly scrolls and highlights at the existing scale and publishes a reading anchor", async () => {
  const s = setup();
  try {
    const before = s.rect("a");
    const pending = s.nav.focusBlock("a");
    expect(s.rect("a")).toEqual(before);
    await vi.advanceTimersByTimeAsync(16);
    expect(s.rect("a").top).toBeCloseTo(before.top);
    expect(s.rect("a").left + s.rect("a").width / 2).toBeCloseTo(
      before.left + before.width / 2,
    );
    await vi.advanceTimersByTimeAsync(96);
    expect(s.viewer.currentScale).toBe(1);
    expect(s.rect("a").width).toBe(before.width);
    expect(s.rect("a").top).toBeLessThan(before.top);
    expect(s.anchor).not.toHaveBeenCalled();
    expect(await finish(pending)).toBe(true);
    expect(s.viewer.currentScale).toBe(1);
    expect(s.viewer.updateScale).not.toHaveBeenCalled();
    expect(s.viewer.refresh).not.toHaveBeenCalled();
    expect(s.anchor).toHaveBeenLastCalledWith({ blockId: "a", fraction: 0.5 });
    centered(s, "a");
    expect(s.focus).toHaveBeenCalledWith("a");
    expect(s.focus).toHaveBeenLastCalledWith(null);
  } finally {
    s.nav.destroy();
  }
});
it("uses the current panel width on repeated clicks without rescaling wide blocks", async () => {
  const s = setup();
  try {
    expect(await finish(s.nav.focusBlock("b"))).toBe(true);
    centered(s, "b");
    const width = s.rect("b").width;
    expect(width).toBeGreaterThan(s.size.width);
    s.size.width = 360;
    expect(await finish(s.nav.focusBlock("b"))).toBe(true);
    centered(s, "b");
    expect(s.rect("b").width).toBe(width);
    expect(s.viewer.updateScale).not.toHaveBeenCalled();
  } finally {
    s.nav.destroy();
  }
});
it("aligns the top of a tall image at the existing scale and replaces unfinished focus", async () => {
  const s = setup();
  try {
    const first = s.nav.focusBlock("a");
    await vi.advanceTimersByTimeAsync(96);
    const before = s.rect("image");
    const second = s.nav.focusBlock("image");
    expect(s.rect("image")).toEqual(before);
    expect(await finish(second)).toBe(true);
    expect(await first).toBe(false);
    centered(s, "image");
    expect(s.rect("image").height).toBeGreaterThan(s.size.height);
    expect(s.rect("image").height).toBe(before.height);
    expect(s.viewer.updateScale).not.toHaveBeenCalled();
    expect(s.focus).toHaveBeenCalledWith("image");
    expect(s.focus).toHaveBeenLastCalledWith(null);
  } finally {
    s.nav.destroy();
  }
});
it("cancels pending page geometry on manual zoom and uses fresh dimensions when page loading completes", async () => {
  const s = setup();
  try {
    let release!: (page: PDFPageProxy) => void;
    s.page.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = s.nav.focusBlock("a");
    s.nav.stop();
    release({ getViewport: () => ({ width: 750 }) } as PDFPageProxy);
    expect(await pending).toBe(false);
    expect(s.viewer.currentScale).toBe(1);
    expect(s.focus).toHaveBeenLastCalledWith(null);
    s.page.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const next = s.nav.focusBlock("a");
    s.size.width = 360;
    release({ getViewport: () => ({ width: 750 }) } as PDFPageProxy);
    expect(await finish(next)).toBe(true);
    expect(s.viewer.currentScale).toBe(1);
    centered(s, "a");
  } finally {
    s.nav.destroy();
  }
});
it("leaves scrolling free after focusing, without snapping, zooming or highlighting a successor", async () => {
  const s = setup();
  try {
    await finish(s.nav.focusBlock("a"));
    const scale = s.viewer.currentScale;
    s.focus.mockClear();
    // Scroll beyond the former midpoint threshold, then across a whole page.
    for (const top of [700, 2000, 100]) {
      const wheel = new WheelEvent("wheel", { deltaY: 100, cancelable: true });
      s.host.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(false);
      s.host.scrollTop = top;
      s.host.dispatchEvent(new Event("scroll"));
      await vi.advanceTimersByTimeAsync(500);
      expect(s.host.scrollTop).toBe(top);
      expect(s.viewer.currentScale).toBe(scale);
    }
    expect(s.focus.mock.calls.every(([id]) => id === null)).toBe(true);
    expect(s.anchor).toHaveBeenCalled(); // position remains available for bilingual sync
  } finally {
    s.nav.destroy();
  }
});
it.each(["wheel", "pointerdown"])(
  "cancels focus on %s and permits another click after manual zoom",
  async (input) => {
    const s = setup();
    try {
      const pending = s.nav.focusBlock("a");
      await vi.advanceTimersByTimeAsync(80);
      s.host.dispatchEvent(new Event(input));
      expect(s.focus).toHaveBeenLastCalledWith(null);
      const top = s.host.scrollTop;
      expect(await finish(pending)).toBe(false);
      expect(s.host.scrollTop).toBe(top);
      expect(s.viewer.currentScale).toBe(1);
      s.nav.stop();
      s.viewer.currentScaleValue = "1.25";
      expect(await finish(s.nav.focusBlock("b"))).toBe(true);
      expect(s.viewer.currentScale).toBe(1.25);
      centered(s, "b");
      const last = s.nav.focusBlock("image");
      s.nav.destroy();
      expect(await finish(last)).toBe(false);
      expect(s.focus).toHaveBeenLastCalledWith(null);
    } finally {
      s.nav.destroy();
    }
  },
);
it("applies reduced motion in one frame without a visual transform", async () => {
  motion.reduced = true;
  const s = setup();
  try {
    const pending = s.nav.focusBlock("a");
    await vi.advanceTimersByTimeAsync(16);
    expect(await pending).toBe(true);
    expect(s.viewer.updateScale).not.toHaveBeenCalled();
    centered(s, "a");
  } finally {
    s.nav.destroy();
  }
});

it.each(["page", "anchor"])(
  "cancels focus when a %s navigation takes over",
  async (kind) => {
    const s = setup();
    try {
      const pending = s.nav.focusBlock("a");
      await vi.advanceTimersByTimeAsync(96);
      const next =
        kind === "page"
          ? s.nav.goTo(2)
          : s.nav.follow({ blockId: "b", fraction: 0.5 });
      expect(s.focus).toHaveBeenLastCalledWith(null);
      await finish(next);
      expect(await pending).toBe(false);
      expect(s.viewer.updateScale).not.toHaveBeenCalled();
    } finally {
      s.nav.destroy();
    }
  },
);
