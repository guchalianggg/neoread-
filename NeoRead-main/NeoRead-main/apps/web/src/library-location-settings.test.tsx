// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryLocationSettings } from "./LibraryLocationSettings";
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () => {
    root.render(<LibraryLocationSettings open={true} />);
  });
it("hides the desktop-only setting in a browser", async () => {
  await render();
  expect(host.innerHTML).toBe("");
});
it("shows the active location and keeps editing blocked while moving", async () => {
  let finish!: (value: boolean) => void;
  const api = {
    platform: "darwin",
    libraryLocation: vi.fn(async () => "/current/library"),
    moveLibrary: vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  vi.stubGlobal("neoreadDesktop", api);
  await render();
  expect(host.textContent).toContain("/current/library");
  await act(async () => host.querySelector("button")!.click());
  expect(api.moveLibrary).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("正在更改书库位置");
  expect(host.querySelector("button")!.disabled).toBe(true);
  await act(async () => finish(false));
  expect(host.querySelector("button")!.disabled).toBe(false);
});
it("shows errors and allows retry without changing the displayed location", async () => {
  vi.stubGlobal("neoreadDesktop", {
    platform: "darwin",
    libraryLocation: async () => "/current/library",
    moveLibrary: async () => {
      throw new Error("目标已存在");
    },
  });
  await render();
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("目标已存在");
  expect(host.textContent).toContain("/current/library");
  expect(host.querySelector("button")!.disabled).toBe(false);
});

it("lets recovery import a library while migration stays disabled, and reports invalid selections", async () => {
  const importLibrary = vi
    .fn()
    .mockRejectedValue(new Error("所选目录不是有效的 NeoRead 书库"));
  vi.stubGlobal("neoreadDesktop", {
    platform: "darwin",
    libraryLocation: async () => "",
    moveLibrary: vi.fn(),
    importLibrary,
  });
  await act(async () => root.render(<LibraryLocationSettings open recovery />));
  const buttons = Array.from(host.querySelectorAll("button"));
  expect(
    buttons.find((b) => b.textContent?.includes("更改位置"))!.disabled,
  ).toBe(true);
  const importButton = buttons.find((b) =>
    b.textContent?.includes("导入书库"),
  )!;
  expect(importButton.disabled).toBe(false);
  await act(async () => importButton.click());
  expect(importLibrary).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "不是有效的 NeoRead 书库",
  );
  expect(importButton.disabled).toBe(false);
});
