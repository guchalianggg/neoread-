// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  findReadingMatches,
  indexReadingContent,
  parseReadingAnchor,
  readingPoint,
  resolveReadingAnchor,
} from "./source-reading-navigation";

function content(html: string) {
  const body = document.createElement("article");
  body.innerHTML = html;
  return body;
}

function viewportAt(top: number) {
  const viewport = document.createElement("div");
  viewport.getBoundingClientRect = () => new DOMRect(0, top, 300, 200);
  return viewport;
}

function layout(body: HTMLElement) {
  body.querySelectorAll<HTMLElement>("[data-top]").forEach((element) => {
    element.getBoundingClientRect = () =>
      new DOMRect(0, Number(element.dataset.top), 300, 20);
  });
  return indexReadingContent(body);
}

describe("semantic reading anchors", () => {
  it("distinguishes repeated headings by hierarchy and occurrence", () => {
    const original = content(`
      <h1 data-top="10">Study A</h1><h2 data-top="40"><em>Results</em></h2>
      <h2 data-top="80" id="second">Results</h2>
      <h1 data-top="120">Study B</h1><h2 data-top="150">Results</h2>
    `);
    const index = layout(original);
    expect(index.headings.map(({ title, level }) => [title, level])).toEqual([
      ["Study A", 1],
      ["Results", 2],
      ["Results", 2],
      ["Study B", 1],
      ["Results", 2],
    ]);
    const first = readingPoint(index, viewportAt(43))!;
    const second = readingPoint(index, viewportAt(84))!;
    const otherParent = readingPoint(index, viewportAt(153))!;
    expect(second.heading).toBe(original.querySelector("#second"));
    expect(first.anchor.heading).not.toEqual(second.anchor.heading);
    expect(first.anchor.heading).not.toEqual(otherParent.anchor.heading);

    const edited = content(`
      <h1>Preface</h1><h2>Results</h2>
      <h1>Study A</h1><h2>Results</h2><h2>New section</h2>
      <h2 id="restored">Results</h2><h1>Study B</h1><h2>Results</h2>
    `);
    expect(
      resolveReadingAnchor(indexReadingContent(edited), second.anchor),
    ).toBe(edited.querySelector("#restored"));
  });

  it("restores the paragraph after insertion of blocks and an identically titled heading", () => {
    const original = content(`
      <h1 data-top="10">Draft</h1><h2 data-top="40">Results</h2><p data-top="70">Other results</p>
      <h2 data-top="100">Results</h2><p data-top="130">Start</p>
      <p data-top="160">My reading position</p>
    `);
    const { anchor } = readingPoint(layout(original), viewportAt(165))!;
    const stored = JSON.stringify(anchor);
    expect(stored).not.toMatch(/Draft|Results|My reading position/u);
    expect(parseReadingAnchor(JSON.parse(stored))).toEqual(anchor);
    const edited = content(`
      <h1>Draft</h1><h2>Results</h2><p>Inserted section</p>
      <h2>Results</h2><p>Other results</p>
      <h2>Results</h2><p>New paragraph</p><p>Start</p>
      <p id="restored">My <em>reading</em> position</p>
    `);
    expect(resolveReadingAnchor(indexReadingContent(edited), anchor)).toBe(
      edited.querySelector("#restored"),
    );
  });

  it.each(["renamed", "deleted"])(
    "falls back to the closest surviving earlier heading when the section is %s",
    (edit) => {
      const original = content(`
      <h1 data-top="10">Study</h1><h2 data-top="40">Methods</h2>
      <h2 data-top="80">Interim</h2><h2 data-top="120">Results</h2>
      <p data-top="150">Section content</p><h2 data-top="180">Discussion</h2>
    `);
      const { anchor } = readingPoint(layout(original), viewportAt(157))!;
      const updated = content(`
      <h1>Study</h1><h2 id="fallback">Methods</h2>
      ${edit === "renamed" ? "<h2>Findings</h2><p>Section content</p>" : ""}
      <h2>Discussion</h2>
    `);
      expect(resolveReadingAnchor(indexReadingContent(updated), anchor)).toBe(
        updated.querySelector("#fallback"),
      );
    },
  );

  it("keeps the current heading until the next crosses the viewport top", () => {
    const body = content(`
      <p data-top="5" id="intro">Introduction without heading</p>
      <h1 data-top="60" id="now">First</h1><p data-top="90" id="paragraph">Text</p>
      <h2 data-top="130" id="later">Later</h2>
    `);
    const index = layout(body);
    const intro = readingPoint(index, viewportAt(40))!;
    expect(intro.heading).toBeNull();
    expect(resolveReadingAnchor(index, intro.anchor)).toBe(
      body.querySelector("#intro"),
    );
    const gap = readingPoint(index, viewportAt(120))!;
    expect(gap.heading).toBe(body.querySelector("#now"));
    expect(resolveReadingAnchor(index, gap.anchor)).toBe(
      body.querySelector("#paragraph"),
    );
    expect(readingPoint(index, viewportAt(130))!.heading).toBe(
      body.querySelector("#later"),
    );
    expect(
      readingPoint(indexReadingContent(content("")), viewportAt(0)),
    ).toBeNull();
  });

  it("validates stored fingerprints, ordinals and trail size", () => {
    const body = content(
      '<h1 data-top="10">First</h1><p data-top="40">Text</p>',
    );
    const { anchor } = readingPoint(layout(body), viewportAt(43))!;
    expect(parseReadingAnchor({ ...anchor, extra: "body text" })).toEqual(
      anchor,
    );
    expect(
      parseReadingAnchor({
        ...anchor,
        heading: { ...anchor.heading, id: "First" },
      }),
    ).toBeNull();
    expect(
      parseReadingAnchor({
        ...anchor,
        block: { ...anchor.block, ordinal: -1 },
      }),
    ).toBeNull();
    expect(
      parseReadingAnchor({
        ...anchor,
        preceding: Array(200).fill(anchor.heading!.id),
      }),
    ).toBeNull();
    expect(parseReadingAnchor({ ...anchor, version: 2 })).toBeNull();
    expect(parseReadingAnchor(null)).toBeNull();
  });
});

describe("reading find", () => {
  it("matches literal Unicode text across inline formatting without mutating DOM", () => {
    const body = content(
      "<p>Start <strong>Café</strong> <em>[A+B]</em> <a>Σς</a> end</p>",
    );
    const original = body.innerHTML;
    const { ranges, limited } = findReadingMatches(body, "CAFÉ [a+b] σσ");
    expect(limited).toBe(false);
    expect(ranges.map(String)).toEqual(["Café [A+B] Σς"]);
    expect(ranges[0].startContainer).toBe(
      body.querySelector("strong")!.firstChild,
    );
    expect(ranges[0].startOffset).toBe(0);
    expect(ranges[0].endContainer).toBe(body.querySelector("a")!.firstChild);
    expect(ranges[0].endOffset).toBe(2);
    expect(body.innerHTML).toBe(original);
    expect(findReadingMatches(body, ".*").ranges).toHaveLength(0);
  });

  it("returns original UTF-16 boundaries for expanding and supplementary case folds", () => {
    const body = content("<p>😀 Stra<strong>ße</strong> 𐐀 İ ı</p>");
    const ranges = (term: string) =>
      findReadingMatches(body, term).ranges.map(String);
    expect(ranges("STRASSE")).toEqual(["Straße"]);
    expect(ranges("𐐨")).toEqual(["𐐀"]);
    expect(ranges("i\u0307")).toEqual(["İ"]);
    expect(ranges("i")).toEqual([]);
    expect(ranges("s")).toEqual(["S"]);
  });

  it("keeps paragraph and cell boundaries and skips controls and KaTeX duplicates", () => {
    const body = content(`
      <p>tail</p><p>head<br>other</p>
      <table><tbody><tr><td>left</td><td>right</td></tr></tbody></table>
      <button>find</button><p hidden>find</p><div style="display:none"><p>find</p></div>
      <p><span class="katex"><span class="katex-mathml">find</span>
      <span class="katex-html" aria-hidden="true">find</span></span></p>
    `);
    for (const term of [
      "tailhead",
      "tail head",
      "leftright",
      "left right",
      "headother",
    ]) {
      expect(findReadingMatches(body, term).ranges).toHaveLength(0);
    }
    const { ranges } = findReadingMatches(body, "find");
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startContainer.parentElement).toBe(
      body.querySelector(".katex-html"),
    );
  });

  it("reports truncation only after the 1,000th match", () => {
    const body = content(`<p>${"a ".repeat(1000)}</p>`);
    expect(findReadingMatches(body, "a")).toMatchObject({ limited: false });
    body.lastElementChild!.append("a");
    const result = findReadingMatches(body, "a");
    expect(result.ranges).toHaveLength(1000);
    expect(result.limited).toBe(true);
    expect(findReadingMatches(body, "")).toEqual({
      ranges: [],
      limited: false,
    });
  });
});
