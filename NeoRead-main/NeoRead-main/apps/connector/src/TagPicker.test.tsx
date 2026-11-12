// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TagPicker } from "./TagPicker";
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});
async function mount(disabled = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const change = vi.fn();
  function Example() {
    const [value, setValue] = useState<string[]>([]);
    return (
      <TagPicker
        options={["安全", "Go", "PDF, EPUB"]}
        value={value}
        onChange={(tags) => {
          setValue(tags);
          change(tags);
        }}
        disabled={disabled}
      />
    );
  }
  await act(async () => root!.render(<Example />));
  return change;
}
function tag(name: string) {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent === `#${name}`)!;
}
it("keeps multiple capsules selected and removes only the toggled tag", async () => {
  const change = await mount();
  await act(async () => tag("安全").click());
  await act(async () => tag("Go").click());
  expect(tag("安全").getAttribute("aria-pressed")).toBe("true");
  expect(tag("Go").getAttribute("aria-pressed")).toBe("true");
  expect(change).toHaveBeenLastCalledWith(["安全", "Go"]);
  await act(async () => tag("安全").click());
  expect(tag("安全").getAttribute("aria-pressed")).toBe("false");
  expect(tag("Go").getAttribute("aria-pressed")).toBe("true");
  expect(change).toHaveBeenLastCalledWith(["Go"]);
  await act(async () => tag("PDF, EPUB").click());
  expect(change).toHaveBeenLastCalledWith(["Go", "PDF, EPUB"]);
});
it("prevents changes during an import", async () => {
  const change = await mount(true);
  await act(async () => tag("安全").click());
  expect(change).not.toHaveBeenCalled();
});
it("adds a new capsule and keeps it available after deselection", async () => {
  const change = await mount();
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="新增标签"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "新标签");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const add = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent === "添加")!;
  await act(async () => add.click());
  expect(change).toHaveBeenLastCalledWith(["新标签"]);
  expect(tag("新标签").getAttribute("aria-pressed")).toBe("true");
  await act(async () => tag("新标签").click());
  expect(tag("新标签").getAttribute("aria-pressed")).toBe("false");
  expect(change).toHaveBeenLastCalledWith([]);
});
