// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HighlightColorsEditor } from "./HighlightColorsEditor";
import { highlightColors } from "./annotations";
import { useReaderStore } from "./store";

let root: Root;
let host: HTMLDivElement;
const labels = () =>
  (useReaderStore.getState().theme.highlightColors ?? highlightColors).map(
    (c) => c.label,
  );
const handle = (label: string) =>
  host.querySelector(`[aria-label="拖动排序${label}"]`) as HTMLButtonElement;
const pointer = (target: Element, type: string, clientY: number) =>
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, button: 0, clientY }),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  // Rows are 32px tall with an 8px gap.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const index = [...(this.parentElement?.children ?? [])].indexOf(this);
      return { top: index * 40, height: 32 } as DOMRect;
    },
  );
  Element.prototype.setPointerCapture = () => {};
  const { theme } = useReaderStore.getState();
  useReaderStore.setState({
    theme: { ...theme, highlightColors: [...highlightColors] },
    setTheme: (patch) =>
      useReaderStore.setState((s) => ({ theme: { ...s.theme, ...patch } })),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

it("drags a color to a new position", async () => {
  await act(async () => root.render(<HighlightColorsEditor />));
  const grip = handle("黄色");
  await act(async () => pointer(grip, "pointerdown", 16));
  // Past the centers of the next two rows.
  await act(async () => pointer(grip, "pointermove", 100));
  expect(labels()).toEqual(["黄色", "绿色", "蓝色", "红色"]);
  await act(async () => pointer(grip, "pointerup", 100));
  expect(labels()).toEqual(["绿色", "蓝色", "黄色", "红色"]);
});

it("reorders from the keyboard and adds from the header", async () => {
  await act(async () => root.render(<HighlightColorsEditor />));
  await act(async () =>
    handle("红色").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    ),
  );
  expect(labels()).toEqual(["黄色", "绿色", "红色", "蓝色"]);
  await act(async () =>
    (
      host.querySelector('[aria-label="添加颜色"]') as HTMLButtonElement
    ).click(),
  );
  expect(labels().at(-1)).toBe("新颜色");
});
