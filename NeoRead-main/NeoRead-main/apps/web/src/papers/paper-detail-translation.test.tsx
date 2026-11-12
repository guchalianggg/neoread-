// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import type { Processing } from "@neoread/core";
import { useReaderStore } from "../store";
import { PaperDetail } from "./PaperDetail";
import type { PaperMenuActions } from "./PaperMenu";
import { paper } from "./fixtures";
import { usePaperUI } from "./state";

vi.mock("@neoread/api", () => ({
  api: {
    assistance: vi.fn(),
    setAssistance: vi.fn(),
    snapshotStatus: vi.fn(async () => ({ available: false })),
    paperAttachments: vi.fn(async () => []),
    journalRankConfig: vi.fn(async () => ({
      enabled: false,
      hasKey: false,
      selected: [],
      available: [],
    })),
    documents: vi.fn(async () => []),
    annotations: vi.fn(async () => []),
    messages: vi.fn(async () => []),
    update: vi.fn(async () => ({})),
  },
  coverURL: (id: string) => `/covers/${id}`,
  publicationURL: (id: string, path: string) => `/publications/${id}/${path}`,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const processing = (patch: Partial<Processing>): Processing =>
  ({
    enabled: false,
    manualTranslation: true,
    retranslating: false,
    phase: "translating",
    status: "paused",
    pagesDone: 2,
    pagesTotal: 2,
    translationsDone: 0,
    translationsTotal: 40,
    detail: "解析完成，等待手动翻译",
    updatedAt: "2026-01-01T00:00:00Z",
    ...patch,
  }) as Processing;

const doc = paper({ id: "p", title: "Attention Is All You Need" });
const actions = {
  open: vi.fn(),
  export: vi.fn(),
  move: vi.fn(),
  trash: vi.fn(),
  newCategory: vi.fn(),
  newTag: vi.fn(),
} as unknown as PaperMenuActions;

let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.clearAllMocks();
  useReaderStore.setState({
    documents: [doc],
    libraryPreferences: {
      mode: "papers",
      papers: { sort: "title", layout: "card" },
    },
  });
  usePaperUI.setState({
    view: "all",
    query: "",
    tagFilter: { tags: [], match: "all" },
    selectedId: null,
    picking: false,
    picked: new Set(),
    anchor: null,
    naming: null,
  });
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

/** The translation action the detail sheet adds under the open button. */
const translate = () =>
  host.querySelector<HTMLButtonElement>(".paper-detail-translate button");

it("starts translation for a parsed paper that waits for it", async () => {
  vi.mocked(api.assistance).mockResolvedValue(processing({}));
  vi.mocked(api.setAssistance).mockResolvedValue(
    processing({ enabled: true, status: "queued", manualTranslation: false }),
  );
  await act(async () => root.render(<PaperDetail doc={doc} actions={actions} />));
  expect(translate()?.textContent).toContain("翻译");
  expect(translate()?.disabled).toBe(false);
  await act(async () => translate()?.click());
  expect(api.setAssistance).toHaveBeenCalledWith("p", "start");
});

it("marks an already translated paper instead of offering the action", async () => {
  vi.mocked(api.assistance).mockResolvedValue(
    processing({
      enabled: true,
      manualTranslation: false,
      phase: "ready",
      status: "complete",
      translationsDone: 40,
      detail: "翻译完成",
    }),
  );
  await act(async () => root.render(<PaperDetail doc={doc} actions={actions} />));
  expect(translate()?.textContent).toContain("已翻译");
  expect(translate()?.disabled).toBe(true);
});

it("shows parsing before translation can start", async () => {
  vi.mocked(api.assistance).mockResolvedValue(
    processing({ enabled: true, status: "running", phase: "learning" }),
  );
  await act(async () => root.render(<PaperDetail doc={doc} actions={actions} />));
  expect(translate()?.textContent).toContain("解析中");
  expect(translate()?.disabled).toBe(true);
});
