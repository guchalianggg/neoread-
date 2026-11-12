// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const source = vi.hoisted(() => ({
  pending: false,
  flush: vi.fn(async () => {}),
}));
vi.mock("./source-edit-state", () => ({
  flushSourceEdits: source.flush,
  hasPendingSourceEdits: () => source.pending,
}));
vi.mock("./paper-note-state", () => ({
  flushPaperNotes: vi.fn(async () => {}),
  hasPendingPaperNotes: () => false,
  takePaperNoteSaveWarning: () => false,
}));
vi.mock("./progress", () => ({ flushProgress: vi.fn(async () => {}) }));
vi.mock("./neoread-settings", () => ({
  saveReaderSettings: vi.fn(async () => {}),
}));
vi.mock("./store", () => ({
  useReaderStore: { getState: () => ({ theme: {} }) },
}));
import { installCloseFlush } from "./close-flush";
import { saveReaderSettings } from "./neoread-settings";
let uninstall: (() => void) | undefined;
beforeEach(() => {
  source.pending = false;
  source.flush.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  Object.defineProperty(window, "neoreadDesktop", {
    configurable: true,
    value: undefined,
  });
  vi.clearAllMocks();
});
function desktopClose() {
  let close!: () => Promise<unknown>;
  Object.defineProperty(window, "neoreadDesktop", {
    configurable: true,
    value: {
      onBeforeClose: (fn: typeof close) => {
        close = fn;
        return () => {};
      },
    },
  });
  uninstall = installCloseFlush();
  return () => close();
}
it("protects browser unload while a source document has unsaved edits", () => {
  uninstall = installCloseFlush();
  source.pending = true;
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});
it("rejects native close when an editable source cannot be saved", async () => {
  source.flush.mockRejectedValueOnce(new Error("保留草稿"));
  const close = desktopClose();
  await expect(close()).rejects.toThrow("保留草稿");
});
it("flushes again after other close writes so late edits are not lost", async () => {
  let finish!: () => void;
  vi.mocked(saveReaderSettings).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const close = desktopClose();
  const closing = close();
  expect(source.flush).toHaveBeenCalledOnce();
  finish();
  await closing;
  expect(source.flush).toHaveBeenCalledTimes(2);
});
it("attempts editable-source saving on pagehide without swallowing native-close errors", async () => {
  uninstall = installCloseFlush();
  window.dispatchEvent(new Event("pagehide"));
  expect(source.flush).toHaveBeenCalledOnce();
  uninstall();
  uninstall = undefined;
  window.dispatchEvent(new Event("pagehide"));
  expect(source.flush).toHaveBeenCalledOnce();
});
