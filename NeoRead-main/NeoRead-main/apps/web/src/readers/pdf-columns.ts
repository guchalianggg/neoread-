import type { PDFBlock } from "@neoread/core";

export type ColumnSide = "left" | "right" | "span";

export interface PageColumnLayout {
  columns: 1 | 2;
  /** 0-1 page width where the two columns split; undefined on single-column pages. */
  split: number | undefined;
  side: Map<string, ColumnSide>;
}

/** Blocks wider than this fraction of the page span both columns (or are headers). */
const NARROW_WIDTH = 0.55;
/** Minimum center gap between the left and right clusters. */
const MIN_GAP = 0.18;
/** Fewest voters on either side to accept a two-column layout. */
const MIN_VOTES = 2;
/** Centers within this distance of the split stay spanning. */
const SPAN_BAND = 0.04;
/** Center gaps within this distance of each other tie; ties bridge straddlers. */
const TIE_EPS = 1e-6;

const cache = new WeakMap<PDFBlock[], Map<number, PageColumnLayout>>();

/**
 * Detect per-page column structure from block bounds (0-1 page coordinates).
 * Narrow body blocks vote by their center x; the widest gap between voting
 * clusters splits the page when both sides reach MIN_VOTES. Equal gaps
 * flanking shared centers expose straddling blocks, and the split bridges
 * across them. Wide blocks and blocks straddling the split span both
 * columns. Three-column pages degrade to two columns without reordering:
 * reading order is preserved because side assignment never rewrites the
 * incoming block sequence.
 */
export function pageColumns(
  blocks: PDFBlock[],
): Map<number, PageColumnLayout> {
  const cached = cache.get(blocks);
  if (cached) return cached;
  const pages = new Map<number, PDFBlock[]>();
  for (const block of blocks) {
    if (!block.text.trim() && !block.image) continue;
    const list = pages.get(block.page);
    if (list) list.push(block);
    else pages.set(block.page, [block]);
  }
  const result = new Map<number, PageColumnLayout>();
  for (const [page, list] of pages) {
    const centers = list
      .filter((b) => b.bounds.width > 0 && b.bounds.width < NARROW_WIDTH)
      .map((b) => b.bounds.x + b.bounds.width / 2)
      .sort((a, b) => a - b);
    let gap = 0,
      bestStart = -1,
      bestEnd = -1;
    // Both clusters need MIN_VOTES voters: i ends the left cluster.
    for (let i = MIN_VOTES - 1; i <= centers.length - MIN_VOTES - 1; i++) {
      const distance = centers[i + 1] - centers[i];
      if (distance > gap + TIE_EPS) {
        gap = distance;
        bestStart = i;
        bestEnd = i + 1;
      } else if (bestStart !== -1 && Math.abs(distance - gap) <= TIE_EPS) {
        // Equal gaps flanking shared centers mean those centers straddle the
        // split (a centered caption, formula, or heading). Bridge across the
        // straddlers instead of cutting beside them, which would drag the
        // split into a real column.
        bestEnd = i + 1;
      }
    }
    const split =
      gap >= MIN_GAP && bestStart !== -1
        ? (centers[bestStart] + centers[bestEnd]) / 2
        : undefined;
    const side = new Map<string, ColumnSide>();
    for (const block of list) {
      if (!split || block.bounds.width >= NARROW_WIDTH) {
        side.set(block.id, "span");
        continue;
      }
      const center = block.bounds.x + block.bounds.width / 2;
      side.set(
        block.id,
        center < split - SPAN_BAND
          ? "left"
          : center > split + SPAN_BAND
            ? "right"
            : "span",
      );
    }
    result.set(page, { columns: split ? 2 : 1, split, side });
  }
  cache.set(blocks, result);
  return result;
}

export type TranslationBand =
  | { kind: "span"; block: PDFBlock }
  | { kind: "columns"; left: PDFBlock[]; right: PDFBlock[] };

/**
 * Slice one page's blocks (in reading order) into vertical bands: spanning
 * blocks stand alone; runs of columnar blocks share a two-column band.
 */
export function columnBands(
  blocks: PDFBlock[],
  layout: PageColumnLayout | undefined,
): TranslationBand[] {
  if (!layout || layout.columns === 1) return [];
  const bands: TranslationBand[] = [];
  let columns: Extract<TranslationBand, { kind: "columns" }> | undefined;
  for (const block of blocks) {
    const side = layout.side.get(block.id) ?? "span";
    if (side === "span") {
      columns = undefined;
      bands.push({ kind: "span", block });
      continue;
    }
    if (!columns) {
      columns = { kind: "columns", left: [], right: [] };
      bands.push(columns);
    }
    (side === "left" ? columns.left! : columns.right!).push(block);
  }
  return bands;
}
