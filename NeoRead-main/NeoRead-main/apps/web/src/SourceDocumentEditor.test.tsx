// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Document, SourceEditSnapshot } from "@neoread/core";
import {
  SourceDocumentEditor,
  sourceEditDownloadName,
} from "./SourceDocumentEditor";
import { getSourceEditStore } from "./source-edit-state";
import { tabCloseWarning } from "./document-tab-guards";

const fake = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  download: vi.fn(),
  blob: vi.fn(),
  diagnostic: vi.fn(),
  getReading: vi.fn(),
  saveReading: vi.fn(),
  print: vi.fn(),
}));
vi.mock("@neoread/api", () => ({
  api: {
    getSourceEdit: fake.get,
    saveSourceEdit: fake.save,
    downloadSourceEdit: fake.download,
    sourceReadingPreferences: fake.getReading,
    saveSourceReadingPreferences: fake.saveReading,
  },
  publicationURL: vi.fn(),
}));
vi.mock("./diagnostics", () => ({ reportDiagnostic: fake.diagnostic }));
vi.mock("./download", async (original) => ({
  ...(await original<typeof import("./download")>()),
  downloadBlob: fake.blob,
}));
vi.mock("./markdown-pdf", async (original) => ({
  ...(await original<typeof import("./markdown-pdf")>()),
  printMarkdownInBrowser: fake.print,
}));
// Isolate lifecycle/protocol tests from Milkdown's asynchronous layout; the real
// shared editor has its own source/rich round-trip tests.
vi.mock("./PaperNoteRichEditor", () => ({
  PaperNoteRichEditor: ({
    body,
    disabled,
    onChange,
  }: {
    body: string;
    disabled: boolean;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="测试正文"
      value={body}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
let root: Root,
  host: HTMLDivElement,
  sequence = 0;
const source = (
  content = "##  Original\n\n* 列表\n",
  revision = 0,
): SourceEditSnapshot => ({
  kind: "md",
  filename: "note.md",
  editable: true,
  revision,
  content,
});
const doc = (id = `source-editor-${++sequence}`) =>
  ({ id, title: id, type: "epub" }) as Document;
const button = (text: string, parent: ParentNode = host) =>
  [...parent.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text || item.ariaLabel === text,
  )!;
const chooseExport = async (format: string) => {
  await act(async () => button("导出").click());
  const item = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((el) => el.textContent?.trim() === format);
  expect(item).toBeDefined();
  await act(async () => item!.click());
};
const field = (parent: ParentNode = host) =>
  parent.querySelector<HTMLTextAreaElement>("textarea")!;
const heading = () => host.querySelector("article h1, article h2")?.textContent;
const focus = () => window.dispatchEvent(new Event("focus"));
type SyncSourceFile = NonNullable<
  NonNullable<Window["neoreadDesktop"]>["syncSourceFile"]
>;
function desktopSync() {
  const sync = vi.fn<SyncSourceFile>().mockResolvedValue({ state: "current" });
  vi.stubGlobal("neoreadDesktop", { syncSourceFile: sync });
  return sync;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const type = (value: string, parent: ParentNode = host) => {
  const input = field(parent);
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const shortcut = (extra: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", {
    key: "s",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  window.dispatchEvent(event);
  return event;
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  fake.get.mockImplementation(async () => source());
  fake.getReading.mockResolvedValue({});
  fake.saveReading.mockResolvedValue({});
  fake.save.mockImplementation(async (_id, payload) => ({
    ...source(),
    ...payload,
    revision: payload.revision + 1,
  }));
  fake.download.mockResolvedValue(new Blob(["download"]));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("loads, edits, saves and reopens a document without normalizing Markdown", async () => {
  const document = doc(),
    back = vi.fn(),
    settings = vi.fn();
  const render = () => (
    <SourceDocumentEditor
      document={document}
      onBack={back}
      onSettings={settings}
    />
  );
  await act(async () => root.render(<StrictMode>{render()}</StrictMode>));
  expect(fake.get).toHaveBeenCalledTimes(1);
  expect(host.querySelector("article h2")?.textContent).toBe("Original");
  expect(field()).toBeNull();
  await act(async () => button("编辑").click());
  expect(field().value).toBe(source().content);
  const exact = "##  中文\n\n-  item\n\n<tag>data</tag>\n";
  await act(async () => type(exact));
  expect(host.querySelector('[role="status"]')?.textContent).toBe("未保存");
  await act(async () => button("保存").click());
  expect(fake.save).toHaveBeenCalledWith(document.id, {
    revision: 0,
    content: exact,
  });
  expect(host.querySelector('[role="status"]')?.textContent).toBe("已保存");
  await act(async () => root.render(null));
  await act(async () => root.render(render()));
  await act(async () => button("编辑").click());
  expect(field().value).toBe(exact);
  await act(async () => {
    button("返回书库").click();
    button("设置").click();
  });
  expect(back).toHaveBeenCalledOnce();
  expect(settings).toHaveBeenCalledOnce();
});

it("exposes read errors and retry without enabling an empty editor", async () => {
  fake.get.mockRejectedValueOnce(new Error("offline"));
  await act(async () =>
    root.render(<SourceDocumentEditor document={doc()} onBack={() => {}} />),
  );
  expect(field()).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "读取失败",
  );
  const event = shortcut();
  expect(event.defaultPrevented).toBe(true);
  expect(fake.save).not.toHaveBeenCalled();
  await act(async () => button("重试").click());
  await act(async () => button("编辑").click());
  expect(field().disabled).toBe(false);
});

it("retains failed drafts and advertises dirty close warnings", async () => {
  const document = doc();
  await act(async () =>
    root.render(<SourceDocumentEditor document={document} onBack={() => {}} />),
  );
  await act(async () => button("编辑").click());
  await act(async () => type("draft"));
  fake.save.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("保存").click());
  expect(field().value).toBe("draft");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "草稿已保留",
  );
  expect(tabCloseWarning(document.id)?.message).toContain("未保存");
  await act(async () => button("重试").click());
  expect(tabCloseWarning(document.id)).toBeNull();
});

it("requires confirmation before replacing a conflicting draft with a newer server revision", async () => {
  const document = doc();
  await act(async () =>
    root.render(<SourceDocumentEditor document={document} onBack={() => {}} />),
  );
  await act(async () => button("编辑").click());
  await act(async () => type("local draft"));
  fake.save.mockRejectedValueOnce({ status: 409 });
  await act(async () => button("保存").click());
  expect(field().value).toBe("local draft");
  expect(button("保存").disabled).toBe(true);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => button("重新加载最新版本").click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(fake.get).toHaveBeenCalledTimes(1);
  expect(field().value).toBe("local draft");
  confirm.mockReturnValue(true);
  fake.get.mockResolvedValueOnce(source("server revision", 8));
  await act(async () => button("重新加载最新版本").click());
  expect(field().value).toBe("server revision");
  expect(getSourceEditStore(document.id).getSnapshot().snapshot?.revision).toBe(
    8,
  );
});

it("keeps input enabled during save, blocks close and flushes later typing", async () => {
  const document = doc();
  let resolve!: (snapshot: SourceEditSnapshot) => void;
  fake.save.mockReturnValueOnce(
    new Promise<SourceEditSnapshot>((yes) => {
      resolve = yes;
    }),
  );
  await act(async () =>
    root.render(<SourceDocumentEditor document={document} onBack={() => {}} />),
  );
  await act(async () => button("编辑").click());
  await act(async () => type("first"));
  await act(async () => button("保存").click());
  expect(field().disabled).toBe(false);
  expect(tabCloseWarning(document.id)?.blocked).toBe(true);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("保存中");
  await act(async () => type("later"));
  await act(async () => {
    resolve(source("first", 1));
  });
  expect(field().value).toBe("later");
  expect(fake.save).toHaveBeenLastCalledWith(document.id, {
    revision: 1,
    content: "later",
  });
  expect(getSourceEditStore(document.id).getSnapshot()).toMatchObject({
    dirty: false,
    snapshot: { revision: 2 },
  });
});

it("isolates multiple tab drafts and only handles shortcuts for the active document", async () => {
  const a = doc(),
    b = doc();
  const render = (active: string) => (
    <>
      <SourceDocumentEditor
        document={a}
        active={active === a.id}
        onBack={() => {}}
      />
      <SourceDocumentEditor
        document={b}
        active={active === b.id}
        onBack={() => {}}
      />
    </>
  );
  await act(async () => root.render(render(a.id)));
  const sections = host.querySelectorAll("section");
  await act(async () => {
    button("编辑", sections[0]).click();
    button("编辑", sections[1]).click();
  });
  await act(async () => {
    type("A draft", sections[0]);
    type("B draft", sections[1]);
  });
  await act(async () => root.render(render(b.id)));
  expect(field(sections[0]).value).toBe("A draft");
  expect(field(sections[1]).value).toBe("B draft");
  await act(async () => {
    expect(shortcut({ metaKey: true, ctrlKey: false }).defaultPrevented).toBe(
      true,
    );
  });
  expect(fake.save).toHaveBeenCalledTimes(1);
  expect(fake.save.mock.calls[0][0]).toBe(b.id);
  expect(tabCloseWarning(a.id)?.message).toContain("未保存");
});

it("consumes repeated/composition saves without issuing writes", async () => {
  const document = doc();
  await act(async () =>
    root.render(<SourceDocumentEditor document={document} onBack={() => {}} />),
  );
  await act(async () => button("编辑").click());
  await act(async () => type("draft"));
  expect(shortcut({ repeat: true }).defaultPrevented).toBe(true);
  expect(shortcut({ isComposing: true }).defaultPrevented).toBe(true);
  expect(fake.save).not.toHaveBeenCalled();
  await act(async () => {
    shortcut();
  });
  expect(fake.save).toHaveBeenCalledTimes(1);
});

it("awaits the download API after saving and changes legacy export extensions", async () => {
  fake.get.mockResolvedValueOnce({
    ...source(),
    kind: "doc",
    filename: "报告.doc",
  });
  let resolve!: (value: Blob) => void;
  fake.download.mockReturnValueOnce(
    new Promise<Blob>((yes) => {
      resolve = yes;
    }),
  );
  await act(async () =>
    root.render(<SourceDocumentEditor document={doc()} onBack={() => {}} />),
  );
  expect(host.textContent).toContain("DOC 将保存为 DOCX");
  expect(button("导出")).toBeUndefined();
  expect(host.textContent).toContain("不保留复杂版式或宏");
  await act(async () => button("下载").click());
  expect(fake.blob).not.toHaveBeenCalled();
  const blob = new Blob(["docx"]);
  await act(async () => {
    resolve(blob);
  });
  expect(fake.blob).toHaveBeenCalledWith(blob, "报告.docx");
  expect(sourceEditDownloadName("BOOK.XLS")).toBe("BOOK.xlsx");
  expect(sourceEditDownloadName("note.markdown")).toBe("note.markdown");
});

it("keeps the Excel download path separate from Markdown export", async () => {
  const blob = new Blob(["xlsx"]);
  fake.get.mockResolvedValueOnce({
    ...source(),
    kind: "xls",
    filename: "表格.XLS",
    sheets: [{ name: "A", rows: [["1"]] }],
  });
  fake.download.mockResolvedValueOnce(blob);
  const document = doc();
  await act(async () =>
    root.render(<SourceDocumentEditor document={document} onBack={() => {}} />),
  );
  expect(button("导出")).toBeUndefined();
  await act(async () => button("下载").click());
  expect(fake.download).toHaveBeenCalledExactlyOnceWith(document.id);
  expect(fake.blob).toHaveBeenCalledExactlyOnceWith(blob, "表格.xlsx");
});

it("does not download stale server contents after a failed save", async () => {
  fake.get.mockResolvedValueOnce({
    ...source(),
    kind: "docx",
    filename: "note.docx",
  });
  await act(async () =>
    root.render(<SourceDocumentEditor document={doc()} onBack={() => {}} />),
  );
  await act(async () => button("编辑").click());
  await act(async () => type("unsaved"));
  fake.save.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("下载").click());
  expect(fake.download).not.toHaveBeenCalled();
  expect(fake.blob).not.toHaveBeenCalled();
  expect(field().value).toBe("unsaved");
});

it("exports exactly the visible, refreshed Markdown as a safely named UTF-8 copy", async () => {
  const exact = "##  外部更新\r\n\r\n*  列表  \r\n\r\n<!-- retained -->\r\n";
  const snapshot = {
    ...source(exact, 1),
    kind: "markdown",
    filename: "CON.笔记\u0000/?:.MARKDOWN",
  } satisfies SourceEditSnapshot;
  fake.get.mockResolvedValueOnce(source()).mockResolvedValueOnce(snapshot);
  const sync = desktopSync().mockResolvedValueOnce({
    state: "updated",
    revision: 1,
  });
  const saveExportFile = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("neoreadDesktop", { syncSourceFile: sync, saveExportFile });
  vi.stubGlobal("Blob", NodeBlob);
  await act(async () =>
    root.render(<SourceDocumentEditor document={doc()} onBack={() => {}} />),
  );
  expect(heading()).toBe("外部更新");
  expect(button("下载")).toBeUndefined();
  await chooseExport("Markdown (.md)");
  expect(saveExportFile).toHaveBeenCalledOnce();
  const [name, bytes] = saveExportFile.mock.calls[0];
  expect(name).toBe("_CON.笔记-----副本.md");
  expect(Array.from(bytes)).toEqual(
    Array.from(new TextEncoder().encode(exact)),
  );
  expect(fake.get).toHaveBeenCalledTimes(2);
  expect(fake.save).not.toHaveBeenCalled();
  expect(fake.download).not.toHaveBeenCalled();
});

it("disables Markdown export while loading, dirty, saving, or in conflict", async () => {
  const document = { ...doc(), sourceFormat: "md" as const };
  const load = deferred<SourceEditSnapshot>();
  const save = deferred<SourceEditSnapshot>();
  fake.get.mockReturnValueOnce(load.promise);
  fake.save
    .mockReturnValueOnce(save.promise)
    .mockRejectedValueOnce({ status: 409 });
  await act(async () =>
    root.render(<SourceDocumentEditor document={document} onBack={() => {}} />),
  );
  expect(button("导出").disabled).toBe(true);
  await act(async () => load.resolve(source()));
  expect(button("导出").disabled).toBe(false);
  await act(async () => button("编辑").click());
  await act(async () => type("# Draft"));
  expect(button("导出").disabled).toBe(true);
  expect(host.textContent).toContain("请先保存修改再导出");
  await act(async () => button("导出").click());
  expect(fake.save).not.toHaveBeenCalled();
  await act(async () => button("保存").click());
  expect(button("导出").disabled).toBe(true);
  await act(async () => save.resolve(source("# Draft", 1)));
  expect(button("导出").disabled).toBe(false);
  await act(async () => type("# Conflicting draft"));
  await act(async () => button("保存").click());
  expect(button("导出").disabled).toBe(true);
  expect(host.textContent).toContain("请先处理冲突再导出");
  expect(fake.download).not.toHaveBeenCalled();
});

it("keeps linked-source checks paused during native PDF save and handles cancellation", async () => {
  const sync = desktopSync();
  const markdownPDF = vi.fn().mockResolvedValue(new Uint8Array([1, 2]));
  const save = deferred<boolean>();
  const saveExportFile = vi.fn().mockReturnValue(save.promise);
  vi.stubGlobal("neoreadDesktop", {
    syncSourceFile: sync,
    markdownPDF,
    saveExportFile,
  });
  vi.stubGlobal("Blob", NodeBlob);
  await act(async () =>
    root.render(<SourceDocumentEditor document={doc()} onBack={() => {}} />),
  );
  await chooseExport("PDF");
  await act(async () => {
    await vi.waitFor(() => expect(saveExportFile).toHaveBeenCalledOnce());
  });
  expect(markdownPDF).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    expect.stringContaining("<h2>Original</h2>"),
  );
  expect(saveExportFile).toHaveBeenCalledExactlyOnceWith(
    "note-副本.pdf",
    new Uint8Array([1, 2]),
  );
  expect(button("导出中").disabled).toBe(true);
  expect(button("检查源文件").disabled).toBe(true);
  await act(async () => {
    focus();
  });
  expect(sync).toHaveBeenCalledOnce();
  await act(async () => save.resolve(false));
  expect(button("导出").disabled).toBe(false);
  expect(button("检查源文件").disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(fake.diagnostic).toHaveBeenCalledWith(
    expect.objectContaining({ event: "markdown.pdf_export.cancelled" }),
  );
});

it("opens browser PDF printing and never treats closing preview as a save", async () => {
  fake.print.mockResolvedValueOnce(undefined);
  await act(async () =>
    root.render(<SourceDocumentEditor document={doc()} onBack={() => {}} />),
  );
  await chooseExport("PDF（打印）");
  await act(async () => {
    await vi.waitFor(() => expect(fake.print).toHaveBeenCalledOnce());
  });
  expect(fake.print).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("<h2>Original</h2>"),
    expect.any(AbortSignal),
    "note-副本",
  );
  expect(button("导出").disabled).toBe(false);
  expect(host.textContent).not.toMatch(/导出成功|文件已保存/);
  expect(fake.diagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "markdown.pdf_export.print_dialog_closed",
    }),
  );
});

it("reports Markdown save failures without exposing the native error", async () => {
  const saveExportFile = vi
    .fn()
    .mockRejectedValue(new Error("private native path"));
  vi.stubGlobal("neoreadDesktop", { saveExportFile });
  vi.stubGlobal("Blob", NodeBlob);
  await act(async () =>
    root.render(<SourceDocumentEditor document={doc()} onBack={() => {}} />),
  );
  await chooseExport("Markdown (.md)");
  expect(button("导出").disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "导出未完成，请重试。",
  );
  expect(fake.diagnostic).toHaveBeenCalledExactlyOnceWith({
    event: "source_edit.markdown_export_failed",
    level: "error",
    detail: "markdown_delivery_failed",
  });
});

it("returns to reading without saving or discarding the draft", async () => {
  const document = doc();
  await act(async () =>
    root.render(<SourceDocumentEditor document={document} onBack={() => {}} />),
  );
  await act(async () => button("编辑").click());
  await act(async () => type("# Draft heading"));
  await act(async () => button("返回阅读").click());
  expect(host.querySelector("article h1")?.textContent).toBe("Draft heading");
  expect(field()).toBeNull();
  expect(fake.save).not.toHaveBeenCalled();
  expect(tabCloseWarning(document.id)?.message).toContain("未保存");
  await act(async () => button("编辑").click());
  expect(field().value).toBe("# Draft heading");
});

it("checks on open, focus and the reading interval; reloads only on an update or newer revision", async () => {
  vi.useFakeTimers();
  const document = doc();
  const sync = desktopSync().mockResolvedValueOnce({
    state: "updated",
    revision: 1,
  });
  fake.get
    .mockResolvedValueOnce(source())
    .mockResolvedValueOnce(source("# From disk", 1));
  await act(async () =>
    root.render(
      <StrictMode>
        <SourceDocumentEditor document={document} onBack={() => {}} />
      </StrictMode>,
    ),
  );
  expect(sync).toHaveBeenCalledExactlyOnceWith(document.id);
  expect(heading()).toBe("From disk");
  expect(host.textContent).toContain("已从源文件更新");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(sync).toHaveBeenCalledTimes(2);
  expect(fake.get).toHaveBeenCalledTimes(2);

  sync.mockResolvedValueOnce({ state: "current", revision: 2 });
  fake.get.mockResolvedValueOnce(source("# Newer revision", 2));
  await act(async () => {
    focus();
  });
  expect(sync).toHaveBeenCalledTimes(3);
  expect(heading()).toBe("Newer revision");
  expect(fake.save).not.toHaveBeenCalled();
});

it("does not overlap checks or fetch over a draft that appeared during IPC", async () => {
  vi.useFakeTimers();
  const document = doc();
  const sync = desktopSync();
  await act(async () =>
    root.render(<SourceDocumentEditor document={document} onBack={() => {}} />),
  );
  const pending = deferred<Awaited<ReturnType<SyncSourceFile>>>();
  sync.mockReturnValueOnce(pending.promise);
  await act(async () => {
    focus();
    focus();
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(sync).toHaveBeenCalledTimes(2);
  expect(button("检查源文件").disabled).toBe(true);
  await act(async () => button("编辑").click());
  await act(async () => {
    focus();
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(sync).toHaveBeenCalledTimes(2);
  await act(async () => type("# Local draft"));
  await act(async () => button("返回阅读").click());
  await act(async () => {
    pending.resolve({ state: "updated", revision: 1 });
  });
  await act(async () => {
    focus();
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(sync).toHaveBeenCalledTimes(2);
  expect(fake.get).toHaveBeenCalledTimes(1);
  expect(heading()).toBe("Local draft");
  expect(button("检查源文件").disabled).toBe(true);
  expect(getSourceEditStore(document.id).getSnapshot()).toMatchObject({
    dirty: true,
    snapshot: { revision: 0, content: "# Local draft" },
  });
});

it("catches up after reopening without applying the previous tab's in-flight read", async () => {
  const document = doc();
  const sync = desktopSync().mockResolvedValueOnce({ state: "updated" });
  const stale = deferred<SourceEditSnapshot>();
  const latest = deferred<SourceEditSnapshot>();
  fake.get
    .mockResolvedValueOnce(source())
    .mockReturnValueOnce(stale.promise)
    .mockReturnValueOnce(latest.promise);
  const render = () => (
    <SourceDocumentEditor document={document} onBack={() => {}} />
  );
  await act(async () => root.render(render()));
  expect(fake.get).toHaveBeenCalledTimes(2);
  await act(async () => root.render(null));
  await act(async () => root.render(render()));
  expect(sync).toHaveBeenCalledTimes(1);
  await act(async () => {
    stale.resolve(source("# Stale response", 1));
  });
  expect(sync).toHaveBeenCalledTimes(2);
  expect(fake.get).toHaveBeenCalledTimes(3);
  expect(heading()).toBe("Original");
  await act(async () => {
    latest.resolve(source("# Latest", 2));
  });
  expect(heading()).toBe("Latest");
});

it("keeps the Reader copy on missing or conflicting source files and permits a manual retry", async () => {
  vi.useFakeTimers();
  const document = doc();
  const sync = desktopSync()
    .mockResolvedValueOnce({ state: "missing" })
    .mockResolvedValueOnce({ state: "conflict" });
  const render = (active: boolean) => (
    <SourceDocumentEditor
      document={document}
      active={active}
      onBack={() => {}}
    />
  );
  await act(async () => root.render(render(false)));
  await act(async () => {
    focus();
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(sync).not.toHaveBeenCalled();
  await act(async () => root.render(render(true)));
  expect(heading()).toBe("Original");
  expect(host.textContent).toContain("找不到源文件，已保留当前副本。");
  await act(async () => button("检查源文件").click());
  expect(host.textContent).toContain("有冲突，已保留当前副本。");
  expect(button("导出").disabled).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(sync).toHaveBeenCalledTimes(2);
  expect(heading()).toBe("Original");
  expect(fake.get).toHaveBeenCalledTimes(1);
  await act(async () => button("检查源文件").click());
  expect(sync).toHaveBeenCalledTimes(3);
  expect(host.textContent).toContain("已链接源文件");
  expect(button("导出").disabled).toBe(false);
});

it("never shows a sync control in a browser, for unlinked sources, or for XLS/XLSX", async () => {
  vi.useFakeTimers();
  const render = () => (
    <SourceDocumentEditor document={doc()} onBack={() => {}} />
  );
  await act(async () => root.render(render()));
  expect(button("检查源文件")).toBeUndefined();
  const sync = desktopSync().mockResolvedValue({ state: "unlinked" });
  await act(async () => root.render(render()));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(button("检查源文件")).toBeUndefined();
  expect(sync).toHaveBeenCalledTimes(1);

  for (const kind of ["xls", "xlsx"] as const) {
    fake.get.mockResolvedValueOnce({
      ...source(),
      kind,
      sheets: [{ name: "A", rows: [["1"]] }],
    });
    await act(async () => root.render(render()));
    await act(async () => {
      focus();
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(button("检查源文件")).toBeUndefined();
  }
  expect(sync).toHaveBeenCalledTimes(1);
});
