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

// Geometry: a 600x600 viewport at the origin renders 600x800 pages, so page
// fractions scale by 600/800. The viewport center (300, 300) sits exactly
// between the two columns, which is where a nearest-block anchor flips to
// the neighbor column while the reader is still inside one of them.
beforeEach(() => {
  motion.reduced = false;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function block(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  page = 1,
): PDFBlock {
  return { id, page, label: "text", text: id, bounds: { x, y, width, height } };
}

function setup() {
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { get: () => 600 },
    clientHeight: { get: () => 600 },
    scrollWidth: { value: 1200 },
    scrollHeight: { value: 2400 },
  });
  host.getBoundingClientRect = () => new DOMRect(0, 0, 600, 600);
  const blocks: PDFBlock[] = [
    block("title", 0.08, 0, 0.84, 0.1),
    block("l1", 0.05, 0.05, 0.4, 0.5),
    block("r1", 0.55, 0.05, 0.4, 0.5),
    block("l2", 0.05, 0.6, 0.4, 0.35),
    block("r2", 0.55, 0.55, 0.4, 0.1),
    block("fig", 0.1, 0.7, 0.8, 0.1),
    block("p2l1", 0.05, 0.05, 0.4, 0.5, 2),
    block("p2r1", 0.55, 0.05, 0.4, 0.5, 2),
    block("p2l2", 0.05, 0.6, 0.4, 0.35, 2),
    block("p2r2", 0.55, 0.6, 0.4, 0.35, 2),
  ];
  const nodes = [0, 1].map((n) => {
    const node = document.createElement("div");
    node.getBoundingClientRect = () =>
      new DOMRect(0, n * 800 - host.scrollTop, 600, 800);
    return node;
  });
  const element = document.createElement("div");
  element.getBoundingClientRect = () =>
    new DOMRect(0, -host.scrollTop, 600, 1600);
  host.append(element);
  const page = vi.fn(
    async () =>
      ({ getViewport: () => ({ width: 750, height: 900 }) }) as PDFPageProxy,
  );
  const viewer = {
    viewer: element,
    currentPageNumber: 1,
    refresh: vi.fn(),
    get currentScale() {
      return 1;
    },
    updateScale: vi.fn(),
    getPageView: (i: number) => ({ div: nodes[i] }),
  } as unknown as PDFViewer;
  const nav = new PDFReadingNavigation(
    host,
    viewer,
    page,
    () => blocks,
    { location: vi.fn(), selection: vi.fn(), readingAnchor: vi.fn() },
    vi.fn(),
  );
  return { host, nav, page };
}


 async function finish(pending: Promise<unknown>) {
   await vi.advanceTimersByTimeAsync(500);
   return await pending;
 }

it("sticks to the column being read instead of flipping to its mirror", async () => {
  const s = setup();
  try {
    // Equidistant columns tie on geometry; reading order wins.
    expect(s.nav.anchor()?.blockId).toBe("l1");
    await finish(s.nav.follow({ blockId: "r2", fraction: 0.5 }));
     expect(s.host.scrollTop).toBeCloseTo(180);
    // Without the sticky side this tie would report l2 again.
    expect(s.nav.anchor()?.blockId).toBe("r2");
    expect(s.nav.anchor()?.fraction).toBe(0.5);
    await finish(s.nav.follow({ blockId: "l2", fraction: 0 }));
    expect(s.nav.anchor()?.blockId).toBe("l2");
  } finally {
    s.nav.destroy();
  }
});

it("drops the sticky column once the reader turns to another page", async () => {
  const s = setup();
  try {
    await finish(s.nav.follow({ blockId: "r2", fraction: 0.5 }));
    s.host.scrollTop = 800;
    // Page 2 columns are equidistant again: the page-1 side must not leak.
    expect(s.nav.anchor()?.blockId).toBe("p2l1");
  } finally {
    s.nav.destroy();
  }
});

it("keeps spanning blocks out of the sticky column without erasing it", async () => {
  const s = setup();
  try {
    await finish(s.nav.follow({ blockId: "r2", fraction: 0.5 }));
    s.host.scrollTop = 460;
    // A spanning figure is never penalized and may win on pure geometry.
    expect(s.nav.anchor()?.blockId).toBe("fig");
    s.host.scrollTop = 180;
    // Anchoring on the span must not clear or poison the remembered side.
    expect(s.nav.anchor()?.blockId).toBe("r2");
  } finally {
    s.nav.destroy();
  }
});

it("remembers the focused column before the zoom motion settles", async () => {
  const s = setup();
  try {
    let release!: (value: PDFPageProxy) => void;
    s.page.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const pending = s.nav.focusBlock("r2");
    await vi.advanceTimersByTimeAsync(0);
    // The click itself is the strongest signal: the tie now resolves to the
    // right column even though the scroll animation has not started yet.
    expect(s.nav.anchor()?.blockId).toBe("r1");
    release(
      { getViewport: () => ({ width: 750, height: 900 }) } as PDFPageProxy,
    );
    expect(await finish(pending)).toBe(true);
  } finally {
    s.nav.destroy();
  }
});
