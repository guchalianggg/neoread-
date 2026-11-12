// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { api } from "@neoread/api";
import { useTranslations } from "./useTranslations";
vi.mock("@neoread/api", () => ({ api: { translationStream: vi.fn() } }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
it("does not drive annotation refresh from chapter snapshots or translation events", async () => {
  let receive!: Parameters<typeof api.translationStream>[2];
  vi.mocked(api.translationStream).mockImplementation(
    async (_id, signal, callback) => {
      receive = callback;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  );
  const changed = vi.fn();
  window.addEventListener("neoread:annotations-changed", changed);
  function Fixture() {
    useTranslations("doc");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Fixture />));
    const data = {
      blockId: "p1-b1",
      sourceHash: "hash",
      status: "complete" as const,
      sentences: [],
    };
    await act(async () => receive({ event: "snapshot", data: [data] }));
    expect(changed).not.toHaveBeenCalled();
    await act(async () => receive({ event: "translation", data }));
    expect(changed).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    window.removeEventListener("neoread:annotations-changed", changed);
  }
});
