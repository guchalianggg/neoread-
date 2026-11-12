// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Document,
  type EPUBReadingBlock,
  type ReaderEvents,
} from "@neoread/core";

const engine = vi.hoisted(() => ({
  events: undefined as ReaderEvents | undefined,
}));
vi.mock("./readers/epub-web", () => ({
  EPUBReaderAdapter: class {
    constructor(_container: HTMLElement, events: ReaderEvents) {
      engine.events = events;
    }
    async open() {}
    async setTheme() {}
    async highlight() {}
    async getTOC() {
      return [];
    }
    async destroy() {}
  },
}));
import { ReaderView } from "./ReaderView";

it("forwards the EPUB block events the engine emits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const events = {
    location: vi.fn(),
    selection: vi.fn(),
    epubBlockHover: vi.fn(),
    epubBlockFocus: vi.fn(),
    epubBlockAction: vi.fn(),
  };
  await act(async () =>
    root.render(
      <ReaderView
        document={{ id: "doc", type: "epub" } as Document}
        theme={defaultTheme}
        annotations={[]}
        events={events}
        onReady={() => {}}
      />,
    ),
  );
  const block = { id: "e-1", text: "Text." } as EPUBReadingBlock;
  engine.events!.epubBlockHover?.("e-1");
  engine.events!.epubBlockFocus?.("e-1");
  engine.events!.epubBlockAction?.(block, "copy");
  expect(events.epubBlockHover).toHaveBeenCalledWith("e-1");
  expect(events.epubBlockFocus).toHaveBeenCalledWith("e-1");
  expect(events.epubBlockAction).toHaveBeenCalledWith(block, "copy");
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
