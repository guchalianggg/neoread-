// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Document } from "@neoread/core";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  documents: vi.fn(),
  saveCover: vi.fn(),
  getDocument: vi.fn(),
  render: vi.fn(),
  savePreferences: vi.fn(),
}));
vi.mock("@neoread/api", () => ({
  api: {
    update: mocks.update,
    documents: mocks.documents,
    saveCover: mocks.saveCover,
    saveLibraryPreferences: mocks.savePreferences,
  },
  coverURL: (id: string, revision?: number) =>
    `/cover/${id}${revision ? "?v" : ""}`,
  publicationURL: (id: string, resource: string) => `/pub/${id}/${resource}`,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  AnnotationMode: { DISABLE: 0 },
  getDocument: mocks.getDocument,
}));
vi.mock("./diagnostics", () => ({ reportDiagnostic: vi.fn() }));

import { BookDetail, saveBookDetailWidth } from "./BookDetail";
import { DetailSheet } from "./DetailSheet";
import { BookCoverImage } from "./book-cover";
import { useReaderStore } from "./store";

const book = (value: Partial<Document> = {}): Document => ({
  id: "b1",
  title: "设计数据密集型应用",
  author: "Martin Kleppmann",
  type: "epub",
  category: "book",
  categorySource: "manual",
  classificationStatus: "done",
  classificationError: "",
  library: "books",
  metadata: {
    publisher: "示例出版社",
    date: "2017-03",
    isbn: "9781449373320",
    abstract: "关于数据系统的书",
  },
  readingStatus: "reading",
  noteCount: 2,
  highlightCount: 0,
  openQuestionCount: 0,
  related: [],
  folders: [],
  tags: ["系统"],
  size: 3 * 1024 * 1024,
  createdAt: "2026-10-01T00:00:00Z",
  lastOpenedAt: "",
  favorite: false,
  percentage: 0.42,
  ...value,
});
const actions = {
  overview: vi.fn(),
  usage: vi.fn(),
  edit: vi.fn(),
  trash: vi.fn(),
};
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({});
  mocks.documents.mockImplementation(
    async () => useReaderStore.getState().documents,
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const field = (label: string) =>
  host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;

it("shows the book's details and saves a rating", async () => {
  const doc = book();
  useReaderStore.setState({ documents: [doc] });
  const open = vi.fn();
  await act(async () =>
    root.render(
      <BookDetail
        doc={doc}
        actions={actions}
        open={open}
        favorite={() => {}}
      />,
    ),
  );
  expect(field("出版社").value).toBe("示例出版社");
  expect(field("出版日期").value).toBe("2017-03");
  expect(field("ISBN").value).toBe("9781449373320");
  expect(field("作者").value).toBe("Martin Kleppmann");
  expect(host.textContent).toContain("EPUB · 3.0 MB");
  expect(host.textContent).toContain("关于数据系统的书");
  expect(host.textContent).toContain("2 条批注");

  await act(async () => field("4 星").click());
  expect(mocks.update).toHaveBeenCalledWith("b1", { metadata: { rating: 4 } });
  expect(useReaderStore.getState().documents[0].metadata.rating).toBe(4);

  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("继续阅读 · 42%"))!
      .click(),
  );
  expect(open).toHaveBeenCalledWith(doc);
});

it("clears the rating when the current score is chosen again", async () => {
  const doc = book({ metadata: { rating: 3 } });
  useReaderStore.setState({ documents: [doc] });
  await act(async () =>
    root.render(
      <BookDetail
        doc={doc}
        actions={actions}
        open={() => {}}
        favorite={() => {}}
      />,
    ),
  );
  expect(field("3 星").getAttribute("aria-checked")).toBe("true");
  await act(async () => field("3 星").click());
  expect(mocks.update).toHaveBeenCalledWith("b1", { metadata: { rating: 0 } });
});

it("keeps the drawn cover when an EPUB has no cover image", async () => {
  await act(async () =>
    root.render(<BookCoverImage doc={book({ id: "no-cover" })} />),
  );
  const img = host.querySelector("img")!;
  expect(img.getAttribute("src")).toBe("/cover/no-cover");
  await act(async () => img.dispatchEvent(new Event("error")));
  expect(host.querySelector("img")).toBeNull();
  expect(mocks.getDocument).not.toHaveBeenCalled();
});

it("renders and stores the first page of a PDF without a cover", async () => {
  const destroy = vi.fn(async () => {});
  const getPage = vi.fn(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    }),
    render: mocks.render.mockReturnValue({ promise: Promise.resolve() }),
  }));
  mocks.getDocument.mockReturnValue({
    promise: Promise.resolve({ getPage }),
    destroy,
  });
  mocks.saveCover.mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    done,
  ) {
    done(new Blob(["jpg"], { type: "image/jpeg" }));
  });
  const pdf = book({ id: "p1", type: "pdf" });
  // The grid card and the detail panel ask for the same cover at once.
  await act(async () =>
    root.render(
      <>
        <BookCoverImage doc={pdf} />
        <BookCoverImage doc={pdf} />
      </>,
    ),
  );
  await act(async () => {
    for (const img of host.querySelectorAll("img"))
      img.dispatchEvent(new Event("error"));
  });
  expect(mocks.getDocument).toHaveBeenCalledOnce();
  expect(getPage).toHaveBeenCalledWith(1);
  const canvas = mocks.render.mock.calls[0][0].canvas as HTMLCanvasElement;
  expect(canvas.width).toBe(420);
  expect(mocks.saveCover).toHaveBeenCalledExactlyOnceWith(
    "p1",
    expect.any(Blob),
  );
  expect(destroy).toHaveBeenCalled();
  const images = host.querySelectorAll("img");
  expect(images).toHaveLength(2);
  for (const img of images) expect(img.getAttribute("src")).toBe("/cover/p1?v");
});

it("resizes the detail sheet and keeps the width", async () => {
  const doc = book();
  mocks.savePreferences.mockResolvedValue({});
  useReaderStore.setState({
    documents: [doc],
    libraryPreferences: { books: { detailWidth: 400 } },
  });
  function Sheet() {
    const width = useReaderStore(
      (s) => s.libraryPreferences.books?.detailWidth,
    );
    return (
      <DetailSheet
        open
        onClose={() => {}}
        container={host}
        label="图书详情"
        width={width}
        saveWidth={saveBookDetailWidth}
      >
        <BookDetail
          doc={doc}
          actions={actions}
          open={() => {}}
          favorite={() => {}}
        />
      </DetailSheet>
    );
  }
  await act(async () => root.render(<Sheet />));
  const handle = host.querySelector<HTMLElement>('[role="separator"]')!;
  const sheet = host.querySelector<HTMLElement>(".detail-sheet")!;
  expect(sheet.querySelector(".book-detail")).not.toBeNull();
  expect(handle.getAttribute("aria-valuenow")).toBe("400");
  expect(sheet.style.getPropertyValue("--paper-detail-width")).toBe("400px");
  vi.spyOn(sheet, "getBoundingClientRect").mockReturnValue({
    width: 400,
  } as DOMRect);
  await act(async () =>
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    ),
  );
  expect(useReaderStore.getState().libraryPreferences.books).toEqual({
    detailWidth: 416,
  });
  expect(mocks.savePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ books: { detailWidth: 416 } }),
  );
  expect(sheet.style.getPropertyValue("--paper-detail-width")).toBe("416px");
});

it("shows only real tags and edits them directly from book details", async () => {
  const doc = book();
  useReaderStore.setState({ documents: [doc] });
  const selectTag = vi.fn();
  await act(async () =>
    root.render(
      <BookDetail
        doc={doc}
        actions={actions}
        open={() => {}}
        favorite={() => {}}
        onSelectTag={selectTag}
      />,
    ),
  );
  expect(host.querySelector('[aria-label="编辑文档信息"]')).toBeNull();
  expect(host.querySelector('[aria-label="标签"]')?.textContent).toContain(
    "#系统",
  );
  expect(host.querySelector('[aria-label="标签"]')?.textContent).not.toContain(
    "书籍",
  );
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "#系统")!
      .click(),
  );
  expect(selectTag).toHaveBeenCalledWith("系统");
  await act(async () => field("删除标签 系统").click());
  expect(mocks.update).toHaveBeenCalledWith("b1", { tags: [] });
  await act(async () =>
    root.render(
      <BookDetail
        doc={useReaderStore.getState().documents[0]}
        actions={actions}
        open={() => {}}
        favorite={() => {}}
        onSelectTag={selectTag}
      />,
    ),
  );
  await act(async () => field("添加标签").click());
  const input =
    document.querySelector<HTMLInputElement>('[aria-label="标签名"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "阅读");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    input
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(mocks.update).toHaveBeenCalledWith("b1", { tags: ["阅读"] });
});

it("shows PDF page counts in book information", async () => {
  const doc = book({ type: "pdf" });
  await act(async () =>
    root.render(
      <BookDetail
        doc={doc}
        actions={actions}
        open={() => {}}
        favorite={() => {}}
        pages={320}
      />,
    ),
  );
  expect(host.textContent).toContain("320 页");
});
