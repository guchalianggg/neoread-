import { readPDFOutline } from "./readers/pdf-outline";
import { buildNavigation } from "./navigation-model";
import type { Annotation, Document } from "@neoread/core";
import { api, publicationURL } from "@neoread/api";
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { toast } from "sonner";
import { downloadBlob, fileTitle } from "./download";
import { annotatedPDF } from "./readers/pdf-export";

/** Saves a copy of the PDF with NeoRead's annotations written into it. */
export async function exportAnnotatedPDF(
  doc: Document,
  kinds?: Annotation["kind"][],
) {
  const [annotations, messages, navigation, blocks] = await Promise.all([
    api.annotations(doc.id),
    api.messages(doc.id),
    api.navigation(doc.id),
    api.blocks(doc.id),
  ]);
  const marks = annotations.filter(
    (a) =>
      a.kind !== "bookmark" &&
      a.location.type === "pdf" &&
      (!kinds || kinds.includes(a.kind)),
  );

  // Loaded on demand so the library does not carry the PDF engine.
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc ||= workerURL;
  const result = await annotatedPDF(
    pdfjs.getDocument,
    {
      url: publicationURL(doc.id, "original.pdf"),
      cMapUrl: "/pdf-assets/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdf-assets/standard_fonts/",
      wasmUrl: "/pdf-assets/wasm/",
    },
    marks,
    {
      answers: Object.fromEntries(messages.map((m) => [m.id, m.content])),
      navigation: async (pdf) =>
        buildNavigation(
          await readPDFOutline(pdf),
          blocks,
          annotations,
          navigation,
        ).filter((item) => !item.id.startsWith("page-")),
    },
  );
  downloadBlob(
    new Blob([result.bytes as Uint8Array<ArrayBuffer>], {
      type: "application/pdf",
    }),
    `${fileTitle(doc.title)}-${result.exported ? "批注" : result.navigationExported ? "目录" : "原文"}.pdf`,
  );
  return result;
}

/** Runs the export with progress and result toasts. */
export function exportAnnotatedPDFWithToast(
  doc: Document,
  kinds?: Annotation["kind"][],
) {
  const id = toast.loading("正在导出 PDF…");
  return exportAnnotatedPDF(doc, kinds).then(
    ({ exported, skipped, navigationExported }) =>
      toast.success(
        `已导出 ${exported} 条批注${navigationExported ? `、${navigationExported} 个导航条目` : ""}`,
        {
          id,
          description: skipped
            ? `${skipped} 条为译文批注或无法定位，未写入`
            : undefined,
        },
      ),
    (error: Error) => toast.error(error.message, { id }),
  );
}
