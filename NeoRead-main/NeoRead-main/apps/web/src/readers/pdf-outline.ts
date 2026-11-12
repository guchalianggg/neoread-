import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type { PDFLocation, TOCItem } from "@neoread/core";

/** Read the file's navigation, preserving page coordinates for same-page ordering. */
export async function readPDFOutline(
  pdf: PDFDocumentProxy,
): Promise<TOCItem[]> {
  const outline = await pdf.getOutline();
  if (!outline?.length)
    return Array.from({ length: pdf.numPages }, (_, i) => ({
      id: `page-${i + 1}`,
      label: `第 ${i + 1} 页`,
      location: { type: "pdf", page: i + 1 },
      children: [],
    }));
  let total = 0;
  const map = async (
    items: NonNullable<typeof outline>,
    prefix = "",
    depth = 0,
  ): Promise<TOCItem[]> => {
    if (depth > 64) throw new Error("PDF 目录层级过深");
    const result: TOCItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (++total > 10000) throw new Error("PDF 目录条目过多");
      const item = items[i],
        path = `${prefix}${i}`;
      const children = await map(item.items, `${path}-`, depth + 1);
      let location: PDFLocation =
        children[0]?.location.type === "pdf"
          ? { ...children[0].location }
          : { type: "pdf", page: 1 };
      try {
        const dest =
          typeof item.dest === "string"
            ? await pdf.getDestination(item.dest)
            : item.dest;
        if (Array.isArray(dest)) {
          const number =
            typeof dest[0] === "number"
              ? dest[0] + 1
              : (await pdf.getPageIndex(dest[0])) + 1;
          if (number < 1 || number > pdf.numPages)
            throw new Error("Invalid page");
          location = { type: "pdf", page: number };
          const mode = dest[1]?.name;
          if (
            mode === "XYZ" ||
            mode === "FitH" ||
            mode === "FitBH" ||
            mode === "FitR"
          ) {
            const page = await pdf.getPage(number),
              viewport = page.getViewport({ scale: 1 });
            const x =
              mode === "XYZ" || mode === "FitR" ? dest[2] : page.view[0];
            const y =
              mode === "XYZ" ? dest[3] : mode === "FitR" ? dest[5] : dest[2];
            if (typeof y === "number" && Number.isFinite(y)) {
              const [vx, vy] = viewport.convertToViewportPoint(
                typeof x === "number" ? x : page.view[0],
                y,
              );
              location.x = Math.max(0, Math.min(1, vx / viewport.width));
              location.y = Math.max(0, Math.min(1, vy / viewport.height));
            }
          }
        }
      } catch {
        /* A broken destination retains its first child's safe page. */
      }
      result.push({
        id: `outline:${path}`,
        label: item.title,
        location,
        children,
      });
    }
    return result;
  };
  const items = await map(outline);
  // Private metadata never supplies destinations or actions. It can only label
  // entries whose actual standard-PDF title and destination still match.
  try {
    const { info } = await pdf.getMetadata();
    const custom = (
      info as { Custom?: Map<string, unknown> | Record<string, unknown> }
    ).Custom;
    const raw =
      custom instanceof Map
        ? custom.get("ReaderNavigation")
        : custom?.ReaderNavigation;
    if (typeof raw !== "string" || raw.length > 2_000_000) return items;
    const data = JSON.parse(raw);
    if (
      data.version !== 1 ||
      !Array.isArray(data.entries) ||
      data.entries.length !== total
    )
      return items;
    const flat: TOCItem[] = [];
    const visit = (list: TOCItem[]) => {
      for (const n of list) {
        flat.push(n);
        visit(n.children);
      }
    };
    visit(items);
    const ids = new Set<string>();
    const valid = data.entries.every((e: unknown, i: number) => {
      if (!e || typeof e !== "object") return false;
      const n = e as {
        id?: unknown;
        kind?: unknown;
        originalLabel?: unknown;
        label?: unknown;
        page?: unknown;
        x?: unknown;
        y?: unknown;
      };
      const location = flat[i].location as PDFLocation;
      if (
        typeof n.id !== "string" ||
        !n.id ||
        n.id.length > 256 ||
        ["__proto__", "prototype", "constructor"].includes(n.id) ||
        ids.has(n.id)
      )
        return false;
      ids.add(n.id);
      const same = (a: unknown, b: number | undefined) =>
        a === b ||
        (typeof a === "number" && b !== undefined && Math.abs(a - b) < 0.00001);
      return (
        (n.kind === "heading" || n.kind === "bookmark") &&
        typeof n.originalLabel === "string" &&
        n.originalLabel.length <= 2000 &&
        n.label === flat[i].label &&
        n.page === location.page &&
        same(n.x, location.x) &&
        same(n.y, location.y)
      );
    });
    if (valid)
      data.entries.forEach(
        (
          n: {
            id: string;
            kind: "heading" | "bookmark";
            originalLabel: string;
          },
          i: number,
        ) => {
          flat[i].id = n.id;
          flat[i].kind = n.kind;
          flat[i].originalLabel = n.originalLabel;
        },
      );
  } catch {
    /* Missing, stale or malformed Reader metadata is a normal PDF. */
  }
  return items;
}
