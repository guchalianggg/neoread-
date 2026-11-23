// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PaperNoteRichEditor } from "./PaperNoteRichEditor";

it("jumps to the selected source heading, not a duplicate or fenced example", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const body = [
    "# Overview",
    "",
    "```md",
    "## Ignore me",
    "```",
    "",
    "## **Chapter**",
    "",
    "Chapter",
    "-------",
  ].join("\r\n");
  const button = (text: string) =>
    Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent === text,
    )!;
  const onChange = vi.fn();
  try {
    await act(async () =>
      root.render(
        <PaperNoteRichEditor
          body={body}
          outline
          disabled={false}
          onChange={onChange}
          onBlur={() => {}}
        />,
      ),
    );
    await act(async () => button("源码").click());
    await act(async () => button("目录").click());
    const entries = [
      ...document.querySelectorAll('nav[aria-label="文档目录"] button'),
    ];
    expect(entries.map((entry) => entry.textContent)).toEqual([
      "Overview",
      "Chapter",
      "Chapter",
    ]);
    await act(async () => (entries[2] as HTMLButtonElement).click());
    const field = host.querySelector("textarea")!;
    expect(field.selectionStart).toBe(field.value.lastIndexOf("Chapter"));
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("jumps to a rendered heading and reads the updated draft on reopening", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const render = (body: string) => (
    <PaperNoteRichEditor
      body={body}
      outline
      disabled={false}
      onChange={onChange}
      onBlur={() => {}}
    />
  );
  const toggle = () =>
    [...host.querySelectorAll("button")].find(
      (item) => item.textContent === "目录",
    )!;
  try {
    await act(async () => root.render(render("# Start\n\n## **Methods**")));
    await act(async () => {
      await vi.waitFor(() =>
        expect(host.querySelector(".ProseMirror h2")).not.toBeNull(),
      );
    });
    const heading = host.querySelector(".ProseMirror h2")!;
    const jump = vi.fn();
    Object.defineProperty(heading, "scrollIntoView", { value: jump });
    await act(async () => toggle().click());
    const entries = [
      ...document.querySelectorAll<HTMLButtonElement>(
        'nav[aria-label="文档目录"] button',
      ),
    ];
    expect(entries.map((entry) => entry.textContent)).toEqual([
      "Start",
      "Methods",
    ]);
    expect(entries[1].style.paddingInlineStart).not.toBe(
      entries[0].style.paddingInlineStart,
    );
    await act(async () => entries[1].click());
    expect(jump).toHaveBeenCalledWith({ block: "start", inline: "nearest" });
    await act(async () => root.render(render("# Updated")));
    await act(async () => toggle().click());
    expect(
      document.querySelector('nav[aria-label="文档目录"]')?.textContent,
    ).toBe("Updated");
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
