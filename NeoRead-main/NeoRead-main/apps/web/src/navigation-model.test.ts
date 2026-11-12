import { expect, it } from "vitest";
import type { Annotation, PDFBlock, TOCItem } from "@neoread/core";
import {
  buildNavigation,
  emptyNavigation,
  flattenTOC,
  moveNavigation,
} from "./navigation-model";
const heading = (id: string, page: number, y = 0): TOCItem => ({
  id,
  label: id,
  location: { type: "pdf", page, x: 0.1, y },
  children: [],
});
const mark = (page: number, y: number): Annotation => ({
  id: "b",
  documentId: "d",
  kind: "bookmark",
  location: { type: "pdf", page, x: 0.1, y },
  note: "My bookmark",
  quote: "",
  color: "",
  createdAt: "",
});
it("uses parsed headings in canonical double-column order instead of page fallback", () => {
  const blocks: PDFBlock[] = [
    {
      id: "left",
      page: 1,
      label: "paragraph_title",
      text: "Left lower",
      bounds: { x: 0.1, y: 0.8, width: 0.35, height: 0.03 },
    },
    {
      id: "right",
      page: 1,
      label: "paragraph_title",
      text: "Right upper",
      bounds: { x: 0.55, y: 0.1, width: 0.35, height: 0.03 },
    },
  ];
  const tree = buildNavigation(
    [{ ...heading("page-1", 1), label: "第 1 页" }],
    blocks,
    [],
    emptyNavigation(),
  );
  expect(tree.map((n) => n.label)).toEqual(["Left lower", "Right upper"]);
  expect(tree[1].location).toMatchObject({ x: 0.55, y: 0.1 });
});
it("rejects cycles, backwards parents and crossing subtree intervals", () => {
  const a = heading("a", 1);
  a.children = [heading("b", 2)];
  const tree = buildNavigation(
    [a, heading("c", 3), heading("d", 4)],
    [],
    [],
    emptyNavigation(),
  );
  expect(moveNavigation(tree, "a", "b")).toBeTruthy();
  expect(moveNavigation(tree, "b", "d")).toBeTruthy();
  expect(moveNavigation(tree, "d", "a")).toBeTruthy(); // c would be after d in preorder
  expect(moveNavigation(tree, "c", "a")).toBeNull();
  expect(moveNavigation(tree, "b", null)).toBeNull();
});
it("inserts bookmarks beside the preceding section and keeps their kind", () => {
  const a = heading("a", 1);
  a.children = [heading("b", 2, 0.2), heading("c", 2, 0.8)];
  const state = emptyNavigation();
  state.entries["bookmark:b"] = { label: "Renamed", collapsed: true };
  const tree = buildNavigation([a], [], [mark(2, 0.5)], state);
  expect(tree[0].children.map((n) => n.id)).toEqual(["b", "bookmark:b", "c"]);
  expect(tree[0].children[1]).toMatchObject({
    kind: "bookmark",
    label: "Renamed",
    originalLabel: "My bookmark",
  });
});
it("keeps a bookmark between a parent title and its first child in source order", () => {
  const a = heading("a", 1, 0.1);
  a.children = [heading("b", 1, 0.8)];
  const tree = buildNavigation([a], [], [mark(1, 0.5)], emptyNavigation());
  expect(flattenTOC(tree).map((n) => n.id)).toEqual(["a", "bookmark:b", "b"]);
  expect(tree[0].children[0].kind).toBe("bookmark");
});
it("keeps explicit edits when new headings arrive without overwriting state", () => {
  const state = emptyNavigation();
  state.entries.c = { label: "Custom", parentId: "a", kind: "bookmark" };
  const a = heading("a", 1);
  a.children = [heading("b", 2)];
  const tree = buildNavigation([a, heading("c", 3)], [], [], state);
  expect(tree[0].children.map((n) => n.id)).toEqual(["b", "c"]);
  expect(tree[0].children[1]).toMatchObject({
    label: "Custom",
    kind: "bookmark",
  });
  expect(state.entries.c.parentId).toBe("a");
});
it("supports moving a heading under an existing personal bookmark", () => {
  const state = emptyNavigation();
  state.entries.c = { parentId: "bookmark:b" };
  const tree = buildNavigation(
    [heading("a", 1), heading("c", 3)],
    [],
    [mark(2, 0.5)],
    state,
  );
  expect(tree[1].id).toBe("bookmark:b");
  expect(tree[1].children.map((n) => n.id)).toEqual(["c"]);
});
it("keeps renamed headings attached when reparsing renumbers paragraph blocks", () => {
  const block: PDFBlock = {
    id: "p1-b2",
    page: 1,
    label: "paragraph_title",
    text: "Methods",
    bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.03 },
  };
  const first = buildNavigation([], [block], [], emptyNavigation());
  const state = emptyNavigation();
  state.entries[first[0].id] = { label: "我的方法" };
  const next = buildNavigation([], [{ ...block, id: "p1-b5" }], [], state);
  expect(next[0].label).toBe("我的方法");
});
it("preserves original order for headings with the exact same destination", () => {
  const a = heading("a", 1, 0.2),
    b = heading("b", 1, 0.2),
    c = heading("c", 1, 0.2);
  const blocks: PDFBlock[] = [
    {
      id: "p1-b1",
      page: 1,
      label: "paragraph_title",
      text: "Title",
      bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
    },
  ];
  const tree = buildNavigation([a, b, c], blocks, [], emptyNavigation());
  expect(moveNavigation(tree, "a", "c")).toBeTruthy();
  expect(moveNavigation(tree, "c", "a")).toBeTruthy();
  expect(moveNavigation(tree, "b", "a")).toBeNull();
});
it("deletes only selected entries and promotes surviving descendants in source order", () => {
  const a = heading("a", 1),
    b = heading("b", 2),
    c = heading("c", 3);
  a.children = [b];
  b.children = [c];
  const state = { revision: 1, entries: { b: { deleted: true } } };
  const tree = buildNavigation([a, heading("d", 4)], [], [], state);
  expect(flattenTOC(tree).map((n) => n.id)).toEqual(["a", "c", "d"]);
  expect(tree[0].children[0].parentId).toBe("a");
  expect(
    buildNavigation([a], [], [], {
      revision: 2,
      entries: {
        a: { deleted: true },
        b: { deleted: true },
        c: { deleted: true },
      },
    }),
  ).toEqual([]);
  expect(
    buildNavigation([], [], [mark(1, 0.5)], {
      revision: 1,
      entries: { "bookmark:b": { deleted: true } },
    }),
  ).toEqual([]);
});
