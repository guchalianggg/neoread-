// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { getSourceEditStore, canRefreshSourceEdit } from "./source-edit-state";
import { useLinkedSourceSync } from "./use-linked-source-sync";

const get = vi.hoisted(() => vi.fn());
vi.mock("@neoread/api", () => ({ api: { getSourceEdit: get } }));
vi.mock("./diagnostics", () => ({ reportDiagnostic: vi.fn() }));

it("refreshes on a Markdown save and queues one check if another save arrives during sync", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const store = getSourceEditStore("watch-markdown-test");
  const snapshot = (revision: number) => ({
    kind: "md",
    editable: true,
    revision,
    filename: "note.md",
    content: `# Revision ${revision}`,
  });
  get.mockResolvedValueOnce(snapshot(1));
  await store.load();
  let notify!: () => void;
  let complete!: (value: { state: "updated"; revision: number }) => void;
  const release = vi.fn();
  const watch = vi.fn((_id: string, cb: () => void) => {
    notify = cb;
    return release;
  });
  const sync = vi
    .fn()
    .mockResolvedValueOnce({ state: "current" })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValueOnce({ state: "updated", revision: 3 });
  vi.stubGlobal("neoreadDesktop", {
    syncSourceFile: sync,
    onMarkdownFileChanged: watch,
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  function Reading() {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
    useLinkedSourceSync(
      "watch-markdown-test",
      store,
      canRefreshSourceEdit(state),
    );
    return <div>{state.snapshot?.content}</div>;
  }
  try {
    await act(async () => root.render(<Reading />));
    expect(watch).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledOnce();
    await act(async () => {
      notify();
      notify();
      notify();
    });
    expect(sync).toHaveBeenCalledTimes(2);
    get.mockResolvedValueOnce(snapshot(2)).mockResolvedValueOnce(snapshot(3));
    await act(async () => complete({ state: "updated", revision: 2 }));
    expect(sync).toHaveBeenCalledTimes(3);
    expect(host.textContent).toBe("# Revision 3");
    await act(async () => store.editContent("unsaved draft"));
    expect(release).toHaveBeenCalledOnce();
    await act(async () => notify());
    expect(sync).toHaveBeenCalledTimes(3);
    expect(host.textContent).toBe("unsaved draft");
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
