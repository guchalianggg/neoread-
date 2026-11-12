import { beforeEach, expect, it, vi } from "vitest";
import type { SourceEditSnapshot } from "@neoread/core";

const fake = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  diagnostic: vi.fn(),
}));
vi.mock("@neoread/api", () => ({
  api: { getSourceEdit: fake.get, saveSourceEdit: fake.save },
}));
vi.mock("./diagnostics", () => ({ reportDiagnostic: fake.diagnostic }));
let state: typeof import("./source-edit-state");
const snapshot = (content = "original", revision = 0): SourceEditSnapshot => ({
  kind: "md",
  filename: "notes.md",
  content,
  revision,
  editable: true,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  fake.get.mockImplementation(async () => snapshot());
  fake.save.mockImplementation(async (_id, payload) => ({
    ...snapshot(),
    ...payload,
    revision: payload.revision + 1,
  }));
  state = await import("./source-edit-state");
});

it("loads once, saves exact Markdown and preserves reopened session state", async () => {
  const store = state.getSourceEditStore("a");
  await Promise.all([store.load(), store.load()]);
  const markdown = "##  标题\r\n\r\n* 列表\n\n<div>raw</div>\n";
  store.editContent(markdown);
  expect(state.hasPendingSourceEdits()).toBe(true);
  await store.save();
  const reopened = state.getSourceEditStore("a");
  await reopened.load();
  expect(fake.get).toHaveBeenCalledTimes(1);
  expect(reopened.getSnapshot()).toMatchObject({
    dirty: false,
    snapshot: { revision: 1, content: markdown },
  });
  expect(fake.save).toHaveBeenCalledWith("a", {
    revision: 0,
    content: markdown,
  });
  expect(state.hasPendingSourceEdits()).toBe(false);
});

it("supports load retry without saving an empty document", async () => {
  fake.get.mockRejectedValueOnce(new Error("offline"));
  const store = state.getSourceEditStore("a");
  await store.load();
  store.editContent("must not create an empty source");
  await store.save();
  expect(store.getSnapshot()).toMatchObject({ dirty: false, loading: false });
  expect(store.getSnapshot().error).toContain("读取失败");
  expect(fake.save).not.toHaveBeenCalled();
  await store.load();
  expect(store.getSnapshot().snapshot?.content).toBe("original");
});

it("retains failed drafts and retries the same base revision", async () => {
  const store = state.getSourceEditStore("a");
  await store.load();
  store.editContent("private draft");
  fake.save.mockRejectedValueOnce(new Error("server echoed private draft"));
  await expect(store.save()).rejects.toThrow();
  expect(store.getSnapshot()).toMatchObject({
    dirty: true,
    saving: false,
    snapshot: { content: "private draft", revision: 0 },
  });
  expect(JSON.stringify(fake.diagnostic.mock.calls)).not.toContain(
    "private draft",
  );
  await store.save();
  expect(store.getSnapshot().dirty).toBe(false);
});

it("does not automatically overwrite a conflicting revision; failed reload retains input", async () => {
  const store = state.getSourceEditStore("a");
  await store.load();
  store.editContent("local");
  fake.save.mockRejectedValueOnce({ status: 409 });
  await expect(store.save()).rejects.toMatchObject({ status: 409 });
  await expect(store.flush()).rejects.toThrow("版本冲突");
  expect(fake.save).toHaveBeenCalledTimes(1);
  expect(fake.get).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot()).toMatchObject({
    dirty: true,
    conflict: true,
    snapshot: { content: "local", revision: 0 },
  });
  fake.get.mockRejectedValueOnce(new Error("offline"));
  await store.reloadConfirmed();
  expect(store.getSnapshot().snapshot?.content).toBe("local");
  expect(store.getSnapshot().conflict).toBe(true);
  fake.get.mockResolvedValueOnce(snapshot("server", 7));
  await store.reloadConfirmed();
  expect(store.getSnapshot()).toMatchObject({
    dirty: false,
    conflict: false,
    snapshot: { content: "server", revision: 7 },
  });
});

it("deduplicates saves and does not replace edits made in flight", async () => {
  const store = state.getSourceEditStore("a");
  await store.load();
  store.editContent("first");
  const pending = deferred<SourceEditSnapshot>();
  fake.save.mockReturnValueOnce(pending.promise);
  const saving = store.save();
  expect(store.save()).toBe(saving);
  await Promise.resolve();
  store.editContent("second");
  pending.resolve(snapshot("first", 1));
  await saving;
  expect(store.getSnapshot()).toMatchObject({
    dirty: true,
    snapshot: { content: "second", revision: 1 },
  });
  await store.flush();
  expect(fake.save).toHaveBeenLastCalledWith("a", {
    revision: 1,
    content: "second",
  });
  expect(store.getSnapshot()).toMatchObject({
    dirty: false,
    snapshot: { content: "second", revision: 2 },
  });
});

it("global close flush saves edits made during an existing save, not just the first version", async () => {
  const a = state.getSourceEditStore("a"),
    b = state.getSourceEditStore("b");
  await Promise.all([a.load(), b.load()]);
  a.editContent("a1");
  b.editContent("b1");
  const pending = deferred<SourceEditSnapshot>();
  fake.save.mockReturnValueOnce(pending.promise);
  const saving = a.save();
  await Promise.resolve();
  const flushing = state.flushSourceEdits();
  a.editContent("a2");
  pending.resolve(snapshot("a1", 1));
  await saving;
  await flushing;
  expect(a.getSnapshot()).toMatchObject({
    dirty: false,
    snapshot: { content: "a2", revision: 2 },
  });
  expect(b.getSnapshot().snapshot?.content).toBe("b1");
  expect(state.hasPendingSourceEdits()).toBe(false);
});

it("global flush reports later save failures and keeps the latest draft", async () => {
  const store = state.getSourceEditStore("a");
  await store.load();
  store.editContent("first");
  const pending = deferred<SourceEditSnapshot>();
  fake.save
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new Error("offline"));
  const flushing = state.flushSourceEdits();
  await Promise.resolve();
  store.editContent("latest");
  pending.resolve(snapshot("first", 1));
  await expect(flushing).rejects.toThrow("offline");
  expect(store.getSnapshot()).toMatchObject({
    dirty: true,
    snapshot: { content: "latest", revision: 1 },
  });
});

it("keeps separate document drafts and flushes all work before reporting a failure", async () => {
  const a = state.getSourceEditStore("a"),
    b = state.getSourceEditStore("b");
  await Promise.all([a.load(), b.load()]);
  a.editContent("A");
  b.editContent("B");
  const pending = deferred<SourceEditSnapshot>();
  fake.save
    .mockRejectedValueOnce(new Error("fail A"))
    .mockReturnValueOnce(pending.promise);
  let finished = false;
  const flushing = state.flushSourceEdits().catch(() => {
    finished = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(finished).toBe(false);
  pending.resolve(snapshot("B", 1));
  await flushing;
  expect(a.getSnapshot().snapshot?.content).toBe("A");
  expect(a.getSnapshot().dirty).toBe(true);
  expect(b.getSnapshot()).toMatchObject({
    dirty: false,
    snapshot: { content: "B" },
  });
});

it("blocks closing while saving and prompts for a dirty draft", async () => {
  // The guard registry is also resetModules-scoped.
  const guards = await import("./document-tab-guards");
  const store = state.getSourceEditStore("guard");
  const unregister = store.registerCloseGuard();
  await store.load();
  expect(guards.tabCloseWarning("guard")).toBeNull();
  store.editContent("draft");
  expect(guards.tabCloseWarning("guard")?.blocked).not.toBe(true);
  expect(guards.tabCloseWarning("guard")?.message).toContain("未保存");
  const pending = deferred<SourceEditSnapshot>();
  fake.save.mockReturnValueOnce(pending.promise);
  const saving = store.save();
  expect(guards.tabCloseWarning("guard")?.blocked).toBe(true);
  pending.resolve(snapshot("draft", 1));
  await saving;
  expect(guards.tabCloseWarning("guard")).toBeNull();
  unregister();
});

it("retains in-flight edits to multiple spreadsheet sheets", async () => {
  const sheetSnapshot: SourceEditSnapshot = {
    kind: "xlsx",
    filename: "book.xlsx",
    editable: true,
    revision: 0,
    sheets: [
      { name: "A", rows: [["1"]] },
      { name: "B", rows: [["2"]] },
    ],
  };
  fake.get.mockResolvedValueOnce(sheetSnapshot);
  const store = state.getSourceEditStore("excel");
  await store.load();
  store.editSheets([
    { name: "A", rows: [["changed"]] },
    sheetSnapshot.sheets![1],
  ]);
  const pending = deferred<SourceEditSnapshot>();
  fake.save.mockReturnValueOnce(pending.promise);
  const saving = store.save();
  const latest = [
    { name: "A", rows: [["changed"]] },
    { name: "B", rows: [["newer"]] },
  ];
  store.editSheets(latest);
  pending.resolve({ ...sheetSnapshot, revision: 1 });
  await saving;
  expect(store.getSnapshot()).toMatchObject({
    dirty: true,
    snapshot: { revision: 1, sheets: latest },
  });
});

it("rejects a non-advancing save response instead of marking the draft saved", async () => {
  const store = state.getSourceEditStore("a");
  await store.load();
  store.editContent("keep");
  fake.save.mockResolvedValueOnce(snapshot("keep", 0));
  await expect(store.save()).rejects.toThrow("修订号");
  expect(store.getSnapshot()).toMatchObject({
    dirty: true,
    snapshot: { content: "keep", revision: 0 },
  });
});

it("reports continuously changing drafts rather than pretending a close flush completed", async () => {
  const store = state.getSourceEditStore("a");
  await store.load();
  store.editContent("first");
  fake.save.mockImplementation(async (_id, payload) => {
    store.editContent(`new draft ${payload.revision + 1}`);
    return snapshot(payload.content, payload.revision + 1);
  });
  await expect(store.flush()).rejects.toThrow("仍在变化");
  expect(fake.save).toHaveBeenCalledTimes(20);
  expect(store.getSnapshot()).toMatchObject({
    dirty: true,
    snapshot: { revision: 20, content: "new draft 20" },
  });
  expect(store.getSnapshot().error).toContain("草稿已保留");
});
