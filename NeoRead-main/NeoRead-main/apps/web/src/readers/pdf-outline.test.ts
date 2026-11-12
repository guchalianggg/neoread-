import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PDFDocument, PDFName, PDFHexString } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readPDFOutline } from "./pdf-outline";
import { writePDFOutline } from "./pdf-outline-export";
import { annotatedPDF } from "./pdf-export";
import type { Annotation, TOCItem } from "@neoread/core";
const fixture = () =>
  readFile(new URL("../../public/samples/reading-notes.pdf", import.meta.url));
it("round trips Unicode labels, kinds, hierarchy, same-page positions and standard annotations", async () => {
  const tree: TOCItem[] = [
    {
      id: "original-1",
      kind: "heading",
      label: "修改后的章节",
      originalLabel: "Original chapter",
      location: { type: "pdf", page: 1, x: 0.1, y: 0.2 },
      children: [
        {
          id: "bookmark:1",
          kind: "bookmark",
          label: "我的书签",
          originalLabel: "Bookmark",
          location: { type: "pdf", page: 1, x: 0.1, y: 0.5 },
          children: [],
        },
      ],
    },
  ];
  const annotation: Annotation = {
    id: "highlight",
    documentId: "d",
    kind: "highlight",
    location: {
      type: "pdf",
      page: 1,
      rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.04 }],
    },
    quote: "test",
    note: "Kept comment",
    color: "#facc15",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const saved = await annotatedPDF(
    getDocument,
    { data: new Uint8Array(await fixture()) },
    [annotation],
    { navigation: async () => tree },
  );
  expect(saved).toMatchObject({ exported: 1, navigationExported: 2 });
  const task = getDocument({ data: saved.bytes });
  try {
    const pdf = await task.promise;
    expect((await pdf.getOutline())?.[0].title).toBe("修改后的章节");
    const imported = await readPDFOutline(pdf);
    expect(imported[0]).toMatchObject({
      id: "original-1",
      kind: "heading",
      originalLabel: "Original chapter",
    });
    expect(imported[0].children[0]).toMatchObject({
      id: "bookmark:1",
      kind: "bookmark",
      label: "我的书签",
    });
    if (imported[0].children[0].location.type !== "pdf") throw Error();
    expect(imported[0].children[0].location.y).toBeCloseTo(0.5);
    expect(
      (await (await pdf.getPage(1)).getAnnotations()).some(
        (a) => a.subtype === "Highlight",
      ),
    ).toBe(true);
  } finally {
    await task.destroy();
  }
});
it("ignores forged/stale Reader markers instead of trusting their type or destination", async () => {
  const original = getDocument({ data: new Uint8Array(await fixture()) });
  let saved: Uint8Array;
  try {
    const pdf = await original.promise;
    saved = await writePDFOutline(
      await pdf.getData(),
      await readPDFOutline(pdf),
      pdf,
    );
  } finally {
    await original.destroy();
  }
  const doc = await PDFDocument.load(saved!);
  const info = doc.context.lookup(
    doc.context.trailerInfo.Info,
  ) as import("pdf-lib").PDFDict;
  info.set(
    PDFName.of("ReaderNavigation"),
    PDFHexString.fromText(
      JSON.stringify({
        version: 1,
        entries: [
          { id: "__proto__", kind: "bookmark", label: "fake", page: 999 },
        ],
      }),
    ),
  );
  const task = getDocument({ data: await doc.save() });
  try {
    const tree = await readPDFOutline(await task.promise);
    expect(tree[0].id).toBe("outline:0");
    expect(tree[0].kind).toBeUndefined();
    expect(tree[0].location).toMatchObject({ page: 1 });
  } finally {
    await task.destroy();
  }
});
it("preserves rotated/cropped page coordinates through export", async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([600, 800]);
  p.setCropBox(50, 100, 400, 600);
  const { degrees } = await import("pdf-lib");
  p.setRotation(degrees(90));
  const task = getDocument({ data: await doc.save() });
  let saved: Uint8Array;
  try {
    const pdf = await task.promise;
    saved = await writePDFOutline(
      await pdf.getData(),
      [
        {
          id: "r",
          label: "Rotated",
          kind: "bookmark",
          location: { type: "pdf", page: 1, x: 0.2, y: 0.6 },
          children: [],
        },
      ],
      pdf,
    );
  } finally {
    await task.destroy();
  }
  const reopened = getDocument({ data: saved! });
  try {
    const tree = await readPDFOutline(await reopened.promise);
    expect(tree[0].kind).toBe("bookmark");
    const l = tree[0].location;
    if (l.type !== "pdf") throw Error();
    expect(l.x).toBeCloseTo(0.2);
    expect(l.y).toBeCloseTo(0.6);
  } finally {
    await reopened.destroy();
  }
});
