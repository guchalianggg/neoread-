// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type PaperAttachment } from "@neoread/api";
import { paper } from "./papers/fixtures";
import { downloadAttachment, useAttachments } from "./papers/attachments";
import { SourceFiles } from "./SourceFiles";

vi.mock("@neoread/api", () => ({ api: { paperAttachments: vi.fn() } }));
vi.mock("./papers/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./papers/attachments")>()),
  downloadAttachment: vi.fn(async () => {}),
}));
const doc = paper({
  id: "source-book",
  type: "epub",
  library: "books",
  attachmentCount: 1,
});
const source: PaperAttachment = {
  id: "source-file",
  documentId: doc.id,
  kind: "file",
  title: "原始文件",
  filename: "论文比较.xlsx",
  mediaType:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size: 2048,
  url: "",
  createdAt: "2026-01-01T00:00:00Z",
};
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api.paperAttachments).mockResolvedValue([source]);
  useAttachments.setState({ items: {}, errors: {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("offers the unchanged source file for download in the book library", async () => {
  await act(async () => root.render(<SourceFiles doc={doc} />));
  expect(api.paperAttachments).toHaveBeenCalledWith(doc.id);
  expect(host.textContent).toContain(source.filename);
  const button = host.querySelector<HTMLButtonElement>(
    '[aria-label="下载 论文比较.xlsx"]',
  )!;
  await act(async () => button.click());
  expect(downloadAttachment).toHaveBeenCalledWith(source);
});
it("shows attachment errors and lets the reader retry", async () => {
  vi.mocked(api.paperAttachments).mockRejectedValueOnce(
    new Error("附件读取失败"),
  );
  await act(async () => root.render(<SourceFiles doc={doc} />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "附件读取失败",
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain(source.filename);
});
