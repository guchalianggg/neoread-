// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryFilterBar, LibraryTagFilters } from "./DocumentManagement";
import { initialFilters } from "./library";

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
it("keeps format and reading filters without the retired content type", async () => {
  await act(async () =>
    root.render(
      <LibraryFilterBar
        documents={[]}
        filters={initialFilters}
        onChange={() => {}}
        view="grid"
        onViewChange={() => {}}
        count={0}
      />,
    ),
  );
  expect(host.querySelector('[aria-label="文档类型筛选"]')).toBeNull();
  expect(host.querySelector('[aria-label="文件格式筛选"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="阅读状态筛选"]')).not.toBeNull();
});
it("shows selected tag chips separately and removes one on click", async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <LibraryTagFilters
        documents={[]}
        filters={{ ...initialFilters, tags: ["ml", "nlp"] }}
        onChange={onChange}
      />,
    ),
  );
  expect(host.textContent).toContain("同时包含");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="取消筛选 ml"]')!
      .click(),
  );
  expect(onChange).toHaveBeenCalledWith({ ...initialFilters, tags: ["nlp"] });
  await act(async () =>
    root.render(
      <LibraryTagFilters
        documents={[]}
        filters={initialFilters}
        onChange={onChange}
      />,
    ),
  );
  expect(host.textContent).toBe("");
});
