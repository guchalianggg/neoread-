// @vitest-environment jsdom
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
}));
vi.mock("@neoread/api", () => ({
  api: {
    getSourceEdit: fake.get,
    saveSourceEdit: fake.save,
    downloadSourceEdit: fake.download,
  },
}));
vi.mock("./diagnostics", () => ({ reportDiagnostic: fake.diagnostic }));
vi.mock("./download", () => ({ downloadBlob: fake.blob }));
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
const field = (parent: ParentNode = host) =>
  parent.querySelector<HTMLTextAreaElement>("textarea")!;
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
  expect(field().disabled).toBe(false);
});

it("retains failed drafts and advertises dirty close warnings", async () => {
  const document = doc();
  await act(async () =>
    root.render(<SourceDocumentEditor document={document} onBack={() => {}} />),
  );
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

it("does not download stale server contents after a failed save", async () => {
  await act(async () =>
    root.render(<SourceDocumentEditor document={doc()} onBack={() => {}} />),
  );
  await act(async () => type("unsaved"));
  fake.save.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("下载").click());
  expect(fake.download).not.toHaveBeenCalled();
  expect(fake.blob).not.toHaveBeenCalled();
  expect(field().value).toBe("unsaved");
});
