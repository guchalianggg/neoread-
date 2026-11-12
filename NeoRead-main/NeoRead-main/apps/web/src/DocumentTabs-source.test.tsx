// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { defaultTheme, type Document } from "@neoread/core";
import { paper } from "./papers/fixtures";
import { useReaderStore } from "./store";
vi.mock("@neoread/api", () => ({ api: {} }));
vi.mock("./Workspace", () => ({
  Workspace: ({ document: doc }: { document: Document }) => (
    <div data-reader={doc.id} />
  ),
}));
vi.mock("./SourceDocumentEditor", () => ({
  SourceDocumentEditor: ({ document: doc }: { document: Document }) => {
    const [draft, setDraft] = useState("");
    return (
      <input
        aria-label={`source ${doc.id}`}
        value={draft}
        onInput={(e) => setDraft(e.currentTarget.value)}
      />
    );
  },
}));
import { ReadingWorkspaces } from "./DocumentTabs";
it("routes source documents to independent retained editor tabs while PDFs keep their reader", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const docs = [
    paper({ id: "pdf" }),
    paper({ id: "md", type: "epub", sourceFormat: "md" }),
    paper({ id: "word", type: "epub", sourceFormat: "docx" }),
  ];
  useReaderStore.setState({
    documents: docs,
    tabIds: [],
    visitedTabs: [],
    active: null,
    theme: defaultTheme,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const s = useReaderStore();
    return (
      <ReadingWorkspaces
        theme={s.theme}
        jobs={[]}
        onLibrary={() => {}}
        onSettings={() => {}}
      />
    );
  }
  try {
    await act(async () => {
      useReaderStore.getState().openMany(docs);
      root.render(<Harness />);
    });
    expect(host.querySelector('[data-reader="pdf"]')).not.toBeNull();
    await act(async () => useReaderStore.getState().open(docs[1]));
    const input = host.querySelector<HTMLInputElement>(
      '[aria-label="source md"]',
    )!;
    await act(async () => {
      input.value = "private draft";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => useReaderStore.getState().open(docs[2]));
    expect(host.querySelector('[aria-label="source word"]')).not.toBeNull();
    expect(input.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(true);
    await act(async () => useReaderStore.getState().open(docs[1]));
    expect(input.value).toBe("private draft");
    expect(useReaderStore.getState().tabIds).toEqual(["pdf", "md", "word"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
