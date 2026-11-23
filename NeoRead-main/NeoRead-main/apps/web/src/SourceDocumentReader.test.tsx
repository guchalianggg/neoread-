// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceDocumentReader } from "./SourceDocumentReader";

const fake = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@neoread/api", () => ({
  api: {
    sourceReadingPreferences: fake.get,
    saveSourceReadingPreferences: fake.put,
  },
}));
vi.mock("./diagnostics", () => ({ reportDiagnostic: vi.fn() }));

const body =
  "# Original\n\nNeed**le** next to a [link](https://example.invalid).\n\n## Repeated\n\nNeedle in the first section.\n\n## Repeated\n\nSecond occurrence with $x^2$.\n\n![Example image](https://example.invalid/image)\n\n```text\n## Not in the outline\n```";
let host: HTMLElement;
let root: Root;
const button = (label: string, within: ParentNode = document) =>
  Array.from(within.querySelectorAll("button")).find(
    (item) => item.textContent === label || item.ariaLabel === label,
  )!;
const width = { value: 1200 };
let resize: ResizeObserverCallback;
const rect = (top: number, height = 30) => new DOMRect(0, top, 500, height);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  width.value = 1200;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => width.value,
  );
  const geometry = new Map<Element, number>();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("source-read-viewport")) return rect(0, 220);
      const area = this.closest<HTMLElement>(".source-read-viewport");
      if (!area || !this.matches("h1,h2,p,pre")) return rect(0);
      if (!geometry.has(this))
        geometry.set(
          this,
          [...area.querySelectorAll("h1,h2,p,pre")].indexOf(this) * 90,
        );
      return rect(geometry.get(this)! - area.scrollTop, 75);
    },
  );
  fake.get.mockResolvedValue({});
  fake.put.mockResolvedValue({});
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shows only inert document content, finds across formatting and cycles through results", async () => {
  await act(async () =>
    root.render(<SourceDocumentReader documentId="a" body={body} active />),
  );
  expect(
    host.querySelector("article a, article img, [contenteditable=true]"),
  ).toBeNull();
  expect(host.querySelector(".katex")).not.toBeNull();
  const shortcut = new KeyboardEvent("keydown", {
    ctrlKey: true,
    key: "f",
    cancelable: true,
  });
  await act(async () => {
    window.dispatchEvent(shortcut);
  });
  expect(shortcut.defaultPrevented).toBe(true);
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "NEEDLE");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelector("output")?.textContent).toBe("1 / 2");
  await act(async () => button("下一处", host).click());
  expect(host.querySelector("output")?.textContent).toBe("2 / 2");
  await act(async () => button("关闭查找", host).click());
  expect(host.querySelector('form[role="search"]')).toBeNull();
});

it("pins the outline only when there is space and restores a document's own location", async () => {
  const preferences = new Map<string, unknown>();
  fake.get.mockImplementation(async (id) => preferences.get(id) ?? {});
  fake.put.mockImplementation(async (id, saved) => {
    preferences.set(id, saved);
    return saved;
  });
  const render = (id: string) => (
    <SourceDocumentReader key={id} documentId={id} body={body} active />
  );
  await act(async () => root.render(render("a")));
  await act(async () => button("目录", host).click());
  const titles = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'nav[aria-label="文档目录"] button',
      ),
    );
  expect(titles().map((item) => item.textContent)).toEqual([
    "Original",
    "Repeated",
    "Repeated",
  ]);
  await act(async () => button("固定目录").click());
  expect(host.querySelector("aside")).not.toBeNull();
  await act(async () => button("宽", host).click());
  expect(host.querySelector("article")?.dataset.width).toBe("wide");
  const area = () =>
    host.querySelector<HTMLElement>('[aria-label="阅读正文"]')!;
  // Simulate a user scrolling down to the paragraph after the second repeated title.
  await act(async () => {
    area().scrollTop = 460;
    area().dispatchEvent(new Event("scroll"));
    await new Promise((done) => requestAnimationFrame(done));
  });
  expect(
    host.querySelector('nav button[aria-current="location"]')?.textContent,
  ).toBe("Repeated");
  await act(async () => root.render(render("b")));
  expect(area().scrollTop).toBe(0);
  expect(host.querySelector("aside")).toBeNull();
  expect(preferences.get("a")).toMatchObject({
    width: "wide",
    pinned: true,
    position: { version: 1 },
  });
  expect(JSON.stringify(preferences.get("a"))).not.toContain(
    "Second occurrence",
  );
  await act(async () => root.render(render("a")));
  expect(area().scrollTop).toBe(450);
  expect(host.querySelector("aside")).not.toBeNull();
  await act(async () => {
    width.value = 620;
    resize([], {} as ResizeObserver);
  });
  expect(host.querySelector("aside")).toBeNull();
  expect(button("目录", host)).toBeTruthy();
});
