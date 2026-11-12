import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFDict,
  type PDFRef,
  type PDFObject,
} from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import type { TOCItem } from "@neoread/core";

/** Standard Outline navigation plus a bounded Reader type manifest. */
export async function writePDFOutline(
  bytes: Uint8Array,
  items: TOCItem[],
  source: PDFDocumentProxy,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes),
    context = doc.context;
  const root = context.obj({ Type: "Outlines" }),
    rootRef = context.register(root);
  const pages = doc.getPages();
  const entries: unknown[] = [];
  async function write(
    nodes: TOCItem[],
    parent: PDFRef,
    depth = 0,
  ): Promise<{ refs: PDFRef[]; count: number }> {
    if (depth > 64) throw new Error("目录层级过深，无法导出");
    const refs: PDFRef[] = [];
    let count = 0;
    const dictionaries: PDFDict[] = [];
    for (const item of nodes) {
      if (entries.length >= 10000) throw new Error("目录条目过多，无法导出");
      if (item.location.type !== "pdf" || !pages[item.location.page - 1])
        throw new Error("目录位置无效，无法导出");
      const l = item.location;
      const dest: (PDFObject | number | null)[] = [
        pages[l.page - 1].ref,
        PDFName.of("Fit"),
      ];
      if (l.y !== undefined) {
        const page = await source.getPage(l.page),
          v = page.getViewport({ scale: 1 });
        const [x, y] = v.convertToPdfPoint(
          (l.x ?? 0) * v.width,
          l.y * v.height,
        );
        dest.splice(1, dest.length, PDFName.of("XYZ"), x, y, null);
      }
      const dict = context.obj({
        Title: PDFHexString.fromText(item.label),
        Parent: parent,
        Dest: dest,
      });
      const ref = context.register(dict);
      refs.push(ref);
      dictionaries.push(dict);
      entries.push({
        id: item.id,
        kind: item.kind ?? "heading",
        originalLabel: item.originalLabel ?? item.label,
        label: item.label,
        page: l.page,
        ...(l.y === undefined ? {} : { x: l.x ?? 0, y: l.y }),
      });
      const children = await write(item.children, ref, depth + 1);
      if (children.refs.length) {
        dict.set(PDFName.of("First"), children.refs[0]);
        dict.set(PDFName.of("Last"), children.refs.at(-1)!);
        dict.set(PDFName.of("Count"), PDFNumber.of(children.count));
      }
      count += 1 + children.count;
    }
    dictionaries.forEach((dict, i) => {
      if (i > 0) dict.set(PDFName.of("Prev"), refs[i - 1]);
      if (i + 1 < refs.length) dict.set(PDFName.of("Next"), refs[i + 1]);
    });
    return { refs, count };
  }
  const children = await write(items, rootRef);
  if (children.refs.length) {
    root.set(PDFName.of("First"), children.refs[0]);
    root.set(PDFName.of("Last"), children.refs.at(-1)!);
    root.set(PDFName.of("Count"), PDFNumber.of(children.count));
  }
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
  let info = context.lookup(context.trailerInfo.Info);
  if (!(info instanceof PDFDict)) {
    info = context.obj({});
    context.trailerInfo.Info = context.register(info);
  }
  const manifest = JSON.stringify({ version: 1, entries });
  if (manifest.length > 2_000_000) throw new Error("目录信息过大，无法导出");
  (info as PDFDict).set(
    PDFName.of("ReaderNavigation"),
    PDFHexString.fromText(manifest),
  );
  return doc.save();
}
