import { describe, expect, it } from "vitest";
import type { PDFBlock } from "@neoread/core";
import { columnBands, pageColumns } from "./pdf-columns";

const block = (id: string, x: number, y: number, width: number, text = id) =>
  ({
    id,
    page: 1,
    label: "text",
    text,
    bounds: { x, y, width, height: 0.1 },
  }) as PDFBlock;

describe("pageColumns", () => {
  it("detects a two-column page and assigns sides", () => {
    const blocks = [
      block("title", 0.05, 0.02, 0.9),
      block("l1", 0.05, 0.15, 0.42),
      block("l2", 0.05, 0.4, 0.42),
      block("r1", 0.53, 0.15, 0.42),
      block("r2", 0.53, 0.4, 0.42),
    ];
    const layout = pageColumns(blocks).get(1)!;
    expect(layout.columns).toBe(2);
    expect(layout.side.get("title")).toBe("span");
    expect(layout.side.get("l1")).toBe("left");
    expect(layout.side.get("r1")).toBe("right");
  });

  it("keeps single-column pages single", () => {
    const blocks = [
      block("t1", 0.08, 0.1, 0.84),
      block("t2", 0.08, 0.3, 0.84),
      block("t3", 0.08, 0.5, 0.84),
    ];
    const layout = pageColumns(blocks).get(1)!;
    expect(layout.columns).toBe(1);
    expect(layout.split).toBeUndefined();
  });

  it("needs votes on both sides", () => {
    const blocks = [
      block("l1", 0.05, 0.15, 0.42),
      block("l2", 0.05, 0.4, 0.42),
      block("r1", 0.53, 0.15, 0.42),
    ];
    expect(pageColumns(blocks).get(1)!.columns).toBe(1);
  });

  it("treats narrow blocks straddling the split as spanning", () => {
    const blocks = [
      block("l1", 0.05, 0.15, 0.42),
      block("l2", 0.05, 0.4, 0.42),
      block("r1", 0.53, 0.15, 0.42),
      block("r2", 0.53, 0.4, 0.42),
      block("caption", 0.3, 0.6, 0.4),
    ];
    const layout = pageColumns(blocks).get(1)!;
    expect(layout.columns).toBe(2);
    expect(layout.side.get("caption")).toBe("span");
  });

  it("degrades three columns without reordering", () => {
    const blocks = [
      block("c1a", 0.03, 0.1, 0.28),
      block("c1b", 0.03, 0.4, 0.28),
      block("c2a", 0.36, 0.1, 0.28),
      block("c2b", 0.36, 0.4, 0.28),
      block("c3a", 0.69, 0.1, 0.28),
      block("c3b", 0.69, 0.4, 0.28),
    ];
    const layout = pageColumns(blocks).get(1)!;
    const sides = blocks.map((b) => layout.side.get(b.id));
    // Either split keeps every narrow block left or right; none is dropped.
    expect(sides).not.toContain(undefined);
  });

  it("caches per blocks reference and groups pages independently", () => {
    const blocks = [
      { ...block("p1a", 0.05, 0.15, 0.42), page: 1 },
      { ...block("p1b", 0.05, 0.4, 0.42), page: 1 },
      { ...block("p1c", 0.53, 0.15, 0.42), page: 1 },
      { ...block("p1d", 0.53, 0.4, 0.42), page: 1 },
      { ...block("p2a", 0.08, 0.1, 0.84), page: 2 },
    ];
    const layouts = pageColumns(blocks);
    expect(layouts.get(1)!.columns).toBe(2);
    expect(layouts.get(2)!.columns).toBe(1);
    expect(pageColumns(blocks)).toBe(layouts);
  });
});

describe("columnBands", () => {
  it("wraps column runs and keeps spanning blocks as their own bands", () => {
    const blocks = [
      block("title", 0.05, 0.02, 0.9),
      block("l1", 0.05, 0.15, 0.42),
      block("l2", 0.05, 0.4, 0.42),
      block("figure", 0.1, 0.55, 0.8),
      block("r1", 0.53, 0.75, 0.42),
      block("r2", 0.53, 0.9, 0.42),
    ];
    const layout = pageColumns(blocks).get(1)!;
    const bands = columnBands(blocks, layout);
    expect(bands.map((b) => b.kind)).toEqual([
      "span",
      "columns",
      "span",
      "columns",
    ]);
    const columnsBand = (band: (typeof bands)[number]) => {
      if (band.kind !== "columns") throw new Error("expected a columns band");
      return band;
    };
    expect(columnsBand(bands[1]).left.map((b) => b.id)).toEqual(["l1", "l2"]);
    expect(columnsBand(bands[3]).right.map((b) => b.id)).toEqual(["r1", "r2"]);
    expect(columnsBand(bands[3]).left).toEqual([]);
  });

  it("returns no bands for single-column layouts", () => {
    const blocks = [block("t1", 0.08, 0.1, 0.84)];
    expect(columnBands(blocks, pageColumns(blocks).get(1))).toEqual([]);
  });
});
