// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type PaperAttachment } from "@neoread/api";
import AttachmentPreview from "./AttachmentPreview";
import { useAttachments } from "./attachments";
import { paper } from "./fixtures";
const mocks = vi.hoisted(() => ({
  destroy: vi.fn(async () => {}),
  getDocument: vi.fn(),
  setDocument: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  AnnotationMode: { DISABLE: 0 },
  getDocument: mocks.getDocument,
}));
vi.mock("pdfjs-dist/web/pdf_viewer.mjs", () => {
  class EventBus {
    handlers = new Map<string, (event?: unknown) => void>();
    on(name: string, callback: (event?: unknown) => void) {
      this.handlers.set(name, callback);
    }
    dispatch = mocks.dispatch;
  }
  class PDFViewer {
    bus: EventBus;
    pagesCount = 3;
    currentScaleValue = "";
    currentScale = 1;
    currentPageNumber = 1;
    constructor({ eventBus }: { eventBus: EventBus }) {
      this.bus = eventBus;
    }
    setDocument(value: unknown) {
      mocks.setDocument(value);
      if (value) this.bus.handlers.get("pagesinit")?.();
    }
    update() {}
  }
  return {
    EventBus,
    PDFViewer,
    PDFLinkService: class {
      setViewer() {}
      setDocument() {}
    },
    PDFFindController: class {
      setDocument() {}
    },
  };
});
vi.mock("@neoread/api", () => ({
  api: { downloadPaperAttachment: vi.fn() },
  paperAttachmentSource: () => ({
    url: "/api/documents/paper/attachments/attachment/file",
    httpHeaders: { Authorization: "Bearer test-secret" },
  }),
}));
vi.mock("./actions", () => ({ openLink: vi.fn() }));
vi.mock("../store", () => ({ refreshLibrary: vi.fn() }));
let root: Root, host: HTMLDivElement;
const doc = paper({ id: "paper" });
const item: PaperAttachment = {
  id: "attachment",
  documentId: "paper",
  kind: "file",
  title: "Supplement",
  filename: "supplement.pdf",
  mediaType: "application/pdf",
  size: 2,
  url: "",
  createdAt: "2026-10-23T00:00:00Z",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:preview");
      static revokeObjectURL = vi.fn();
    },
  );
  mocks.getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages: 3 }),
    destroy: mocks.destroy,
  });
  const blob = new Blob(["pdf"]);
  Object.defineProperty(blob, "arrayBuffer", {
    value: async () => new ArrayBuffer(3),
  });
  vi.mocked(api.downloadPaperAttachment).mockResolvedValue(blob);
  useAttachments.setState({ preview: { doc, item } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
it("renders PDFs with PDF.js and releases the document on close", async () => {
  await act(async () => root.render(<AttachmentPreview />));
  expect(mocks.getDocument).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("1 / 3");
  expect(api.downloadPaperAttachment).not.toHaveBeenCalled();
  await act(async () => useAttachments.setState({ preview: null }));
  expect(mocks.destroy).toHaveBeenCalledOnce();
  expect(mocks.setDocument).toHaveBeenLastCalledWith(null);
});
it("aborts an image download when closing before its response arrives", async () => {
  useAttachments.setState({
    preview: { doc, item: { ...item, filename: "chart.png" } },
  });
  let resolve!: (value: Blob) => void;
  vi.mocked(api.downloadPaperAttachment).mockImplementation(
    async () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () => root.render(<AttachmentPreview />));
  const signal = vi.mocked(api.downloadPaperAttachment).mock.calls[0][2]!;
  await act(async () => useAttachments.setState({ preview: null }));
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(new Blob(["late response"])));
  expect(mocks.getDocument).not.toHaveBeenCalled();
});
it("revokes image previews when closed", async () => {
  useAttachments.setState({
    preview: { doc, item: { ...item, filename: "chart.png" } },
  });
  await act(async () => root.render(<AttachmentPreview />));
  expect(document.querySelector('img[alt="Supplement"]')).not.toBeNull();
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  await act(async () => useAttachments.setState({ preview: null }));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  expect(mocks.getDocument).not.toHaveBeenCalled();
});

it("loads a 512 MB PDF through authenticated ranges without a whole-file blob", async () => {
  useAttachments.setState({
    preview: { doc, item: { ...item, size: 512 * 1024 * 1024 } },
  });
  await act(async () => root.render(<AttachmentPreview />));
  expect(api.downloadPaperAttachment).not.toHaveBeenCalled();
  expect(mocks.getDocument).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "/api/documents/paper/attachments/attachment/file",
      httpHeaders: { Authorization: "Bearer test-secret" },
      disableStream: true,
      disableAutoFetch: true,
    }),
  );
  expect(mocks.getDocument.mock.calls[0][0]).not.toHaveProperty("data");
});

it("destroys pending PDF range loading and ignores a late document after close", async () => {
  let resolve!: (value: { numPages: number }) => void;
  const pdfDocument = { numPages: 10 };
  mocks.getDocument.mockReturnValue({
    promise: new Promise((done) => {
      resolve = done;
    }),
    destroy: mocks.destroy,
  });
  await act(async () => root.render(<AttachmentPreview />));
  expect(mocks.getDocument).toHaveBeenCalledOnce();
  await act(async () => useAttachments.setState({ preview: null }));
  expect(mocks.destroy).toHaveBeenCalledOnce();
  await act(async () => resolve(pdfDocument));
  expect(mocks.setDocument).not.toHaveBeenCalledWith(pdfDocument);
});
