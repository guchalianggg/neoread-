type HeadingIdentity = { id: string; group: string };
type BlockIdentity = { hash: string; ordinal: number; occurrence: number };

/** A position in one document. Only fingerprints and ordinals are persisted. */
export type ReadingAnchor = {
  version: 1;
  heading: HeadingIdentity | null;
  preceding: string[];
  block: BlockIdentity | null;
};

type Heading = { element: HTMLElement; title: string; level: number };
type Block = {
  element: HTMLElement;
  section: Section;
  identity: BlockIdentity | null;
};
type Section = {
  heading: Heading | null;
  identity: HeadingIdentity | null;
  parent: Section | null;
  order: number;
  blocks: Block[];
  byHash: Map<string, Block[]>;
};

export type ReadingIndex = {
  headings: Array<{ element: HTMLElement; title: string; level: number }>;
  blocks: Block[];
  intro: Section;
  sections: Section[];
  byId: Map<string, Section>;
  byGroup: Map<string, Section[]>;
};

const precedingLimit = 16;
const trailLimit = precedingLimit + 5; // Allow for up to five ancestor headings.
const matchLimit = 1000;
const skipSelector = [
  "[hidden]",
  "[data-source-reading-ignore]",
  '[aria-hidden="true"]:not(.katex-html)', // KaTeX's visible branch is aria-hidden.
  ".katex-mathml",
  ".sr-only",
  ".visually-hidden",
  "button",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  "script",
  "style",
  "template",
  "noscript",
  "svg",
].join(",");
const blockTags = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tfoot",
  "tr",
  "ul",
]);
const headingLevel = (tag: string): number =>
  /^h[1-6]$/.test(tag) ? Number(tag[1]) : 0;
const isBlock = (tag: string) => blockTags.has(tag) || headingLevel(tag) !== 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{16}$/.test(value);
}

function isOrdinal(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 0xffffffff
  );
}

/** Validate and copy storage data without passing through unknown fields. */
export function parseReadingAnchor(value: unknown): ReadingAnchor | null {
  try {
    if (!isRecord(value) || value.version !== 1) return null;
    const { heading, preceding, block } = value;
    let safeHeading: HeadingIdentity | null = null;
    if (heading !== null) {
      if (!isRecord(heading)) return null;
      const { id, group } = heading;
      if (!isHash(id) || !isHash(group)) return null;
      safeHeading = { id, group };
    }
    if (!Array.isArray(preceding) || preceding.length > trailLimit) return null;
    const safePreceding: string[] = [];
    for (let i = 0; i < preceding.length; i++) {
      const hash: unknown = preceding[i];
      if (!isHash(hash)) return null;
      safePreceding.push(hash);
    }
    let safeBlock: BlockIdentity | null = null;
    if (block !== null) {
      if (!isRecord(block)) return null;
      const { hash, ordinal, occurrence } = block;
      if (
        !isHash(hash) ||
        !isOrdinal(ordinal) ||
        !isOrdinal(occurrence) ||
        occurrence > ordinal
      )
        return null;
      safeBlock = { hash, ordinal, occurrence };
    }
    if (!safeHeading && (!safeBlock || safePreceding.length)) return null;
    return {
      version: 1,
      heading: safeHeading,
      preceding: safePreceding,
      block: safeBlock,
    };
  } catch {
    return null;
  }
}

// Two 32-bit accumulators, for deterministic compact identities rather than security.
function fingerprint(value: string) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  return (
    (a >>> 0).toString(16).padStart(8, "0") +
    (b >>> 0).toString(16).padStart(8, "0")
  );
}

type ContentEvent =
  { type: "open" | "close"; node: HTMLElement } | { type: "text"; node: Text };

/** Walk the rendered subtree without retaining skipped UI or doing layout reads on scroll. */
function* contentEvents(body: HTMLElement): Generator<ContentEvent> {
  const view = body.ownerDocument.defaultView;
  let node = body.firstChild;
  while (node) {
    const parent = node.parentElement;
    const insideClosedDetails =
      parent?.localName === "details" && !parent.hasAttribute("open");
    if (node.nodeType === 1) {
      const element = node as HTMLElement;
      if (
        (!insideClosedDetails || element.localName === "summary") &&
        !element.matches(skipSelector)
      ) {
        const style = view?.getComputedStyle(element);
        if (
          style?.display !== "none" &&
          style?.visibility !== "hidden" &&
          style?.visibility !== "collapse"
        ) {
          yield { type: "open", node: element };
          if (element.firstChild) {
            node = element.firstChild;
            continue;
          }
          yield { type: "close", node: element };
        }
      }
    } else if (
      node.nodeType === 3 &&
      !insideClosedDetails &&
      (node as Text).length
    ) {
      yield { type: "text", node: node as Text };
    }
    while (!node.nextSibling) {
      node = node.parentElement;
      if (!node || node === body) return;
      yield { type: "close", node: node as HTMLElement };
    }
    node = node.nextSibling;
  }
}

type BlockDraft = { element: HTMLElement; parts: string[]; used: boolean };

function blockDrafts(body: HTMLElement): BlockDraft[] {
  const drafts: BlockDraft[] = [];
  const stack: BlockDraft[] = [{ element: body, parts: [], used: false }];
  const use = (block: BlockDraft) => {
    if (!block.used) {
      block.used = true;
      drafts.push(block);
    }
  };
  for (const event of contentEvents(body)) {
    const current = stack[stack.length - 1];
    if (event.type === "text") {
      current.parts.push(event.node.data);
      if (/\S/u.test(event.node.data)) use(current);
    } else if (event.type === "close") {
      if (event.node === current.element) stack.pop();
    } else {
      const element = event.node;
      const tag = element.localName;
      if (
        tag === "br" ||
        (current.element.localName === "tr" && (tag === "td" || tag === "th"))
      ) {
        current.parts.push(" ");
      } else if (tag === "img") {
        current.parts.push(element.getAttribute("alt") ?? "");
        use(current);
      } else if (current.element.localName !== "tr" && isBlock(tag)) {
        // Table rows are one vertical reading stop; find still treats each cell separately.
        const next = { element, parts: [], used: false };
        stack.push(next);
        if (headingLevel(tag) || tag === "hr") use(next);
      }
    }
  }
  return drafts;
}

export function indexReadingContent(body: HTMLElement): ReadingIndex {
  const newSection = (
    heading: Heading | null,
    identity: HeadingIdentity | null,
    parent: Section | null,
    order: number,
  ): Section => ({
    heading,
    identity,
    parent,
    order,
    blocks: [],
    byHash: new Map(),
  });
  const intro = newSection(null, null, null, -1);
  const index: ReadingIndex = {
    headings: [],
    blocks: [],
    intro,
    sections: [],
    byId: new Map(),
    byGroup: new Map(),
  };
  const siblings = new Map<string, number>();
  let section = intro;
  for (const { element, parts } of blockDrafts(body)) {
    const text = parts.join("").replace(/\s+/gu, " ").trim();
    const level = headingLevel(element.localName);
    if (level) {
      let parent = section;
      while (parent.heading && parent.heading.level >= level)
        parent = parent.parent!;
      const title = fingerprint(text.normalize("NFC").toLowerCase());
      const path = `${parent.identity?.id ?? ""}/${level}/${title}`;
      const occurrence = siblings.get(path) ?? 0;
      siblings.set(path, occurrence + 1);
      const identity = {
        id: fingerprint(`${path}/${occurrence}`),
        group: fingerprint(`${parent.identity?.group ?? ""}/${level}/${title}`),
      };
      const heading = { element, title: text, level };
      section = newSection(heading, identity, parent, index.sections.length);
      index.headings.push(heading);
      index.sections.push(section);
      index.byId.set(identity.id, section);
      const group = index.byGroup.get(identity.group) ?? [];
      group.push(section);
      index.byGroup.set(identity.group, group);
      index.blocks.push({ element, section, identity: null });
    } else {
      const hash = fingerprint(`${element.localName}/${text.normalize("NFC")}`);
      const same = section.byHash.get(hash) ?? [];
      const identity = {
        hash,
        ordinal: section.blocks.length,
        occurrence: same.length,
      };
      const block = { element, section, identity };
      same.push(block);
      section.byHash.set(hash, same);
      section.blocks.push(block);
      index.blocks.push(block);
    }
  }
  return index;
}

function firstTrue(length: number, test: (i: number) => boolean) {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (test(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

export function readingPoint(
  index: ReadingIndex,
  viewport: HTMLElement,
): { anchor: ReadingAnchor; heading: HTMLElement | null } | null {
  if (!index.blocks.length) return null;
  const viewportRect = viewport.getBoundingClientRect();
  const top = viewportRect.top + viewport.clientTop;
  const bottom = viewport.clientHeight
    ? top + viewport.clientHeight
    : viewportRect.bottom;
  const nextIndex = firstTrue(
    index.blocks.length,
    (i) => index.blocks[i].element.getBoundingClientRect().top > top,
  );
  const previous = index.blocks[nextIndex - 1];
  const next = index.blocks[nextIndex];
  const block =
    !previous ||
    (next &&
      next.section === previous.section &&
      previous.element.getBoundingClientRect().bottom <= top &&
      next.element.getBoundingClientRect().top < bottom)
      ? next
      : previous;
  if (!block) return null;

  const { section } = block;
  const preceding = index.sections
    .slice(
      Math.max(0, section.order - precedingLimit),
      Math.max(0, section.order),
    )
    .reverse()
    .map((item) => item.identity!.id);
  for (let parent = section.parent; parent?.identity; parent = parent.parent) {
    if (!preceding.includes(parent.identity.id))
      preceding.push(parent.identity.id);
  }
  return {
    anchor: {
      version: 1,
      heading: section.identity,
      preceding,
      block: block.identity,
    },
    heading: previous ? (section.heading?.element ?? null) : null,
  };
}

export function resolveReadingAnchor(
  index: ReadingIndex,
  anchor: ReadingAnchor,
): HTMLElement | null {
  const { heading, block } = anchor;
  const documentStart = index.blocks[0]?.element ?? null;
  const exact = heading ? index.byId.get(heading.id) : index.intro;
  if (block) {
    const same = exact?.byHash.get(block.hash);
    if (same?.length)
      return same[Math.min(block.occurrence, same.length - 1)].element;

    // If an identical heading was inserted earlier, its occurrence can have shifted.
    // Only prefer a different occurrence when the paragraph is an exact content match.
    if (heading) {
      let best: Block | undefined;
      let distance = Infinity;
      for (const section of index.byGroup.get(heading.group) ?? []) {
        const candidates = section.byHash.get(block.hash);
        if (!candidates?.length) continue;
        const candidate =
          candidates[Math.min(block.occurrence, candidates.length - 1)];
        const score = exact
          ? Math.abs(section.order - exact.order)
          : Math.abs(candidate.identity!.ordinal - block.ordinal);
        if (score < distance) {
          best = candidate;
          distance = score;
        }
      }
      if (best) return best.element;
    }
    if (exact?.blocks.length)
      return exact.blocks[Math.min(block.ordinal, exact.blocks.length - 1)]
        .element;
  }
  if (exact?.heading) return exact.heading.element;
  for (const id of anchor.preceding) {
    const heading = index.byId.get(id)?.heading;
    if (heading) return heading.element;
  }
  return documentStart;
}

function* textRuns(body: HTMLElement): Generator<Text[]> {
  let run: Text[] = [];
  for (const event of contentEvents(body)) {
    if (event.type === "text") {
      run.push(event.node);
    } else if (
      run.length &&
      (isBlock(event.node.localName) || event.node.localName === "br")
    ) {
      yield run;
      run = [];
    }
  }
  if (run.length) yield run;
}

type Expansion = {
  start: number;
  end: number;
  originalStart: number;
  originalEnd: number;
};

function foldText(text: string) {
  const expansions: Expansion[] = [];
  if (/^[\x00-\x7f]*$/.test(text))
    return { folded: text.toLowerCase(), expansions };
  let folded = "";
  let originalStart = 0;
  for (const character of text) {
    // Default Unicode folding from JS case mappings. Cherokee folds to uppercase;
    // dotless i remains distinct unless using the optional Turkic tailoring.
    const code = character.charCodeAt(0);
    const cherokee =
      (code >= 0x13a0 && code <= 0x13ff) || (code >= 0xab70 && code <= 0xabbf);
    const value = cherokee
      ? character.toUpperCase()
      : character === "ı"
        ? character
        : character.toLowerCase().toUpperCase().toLowerCase();
    if (value.length !== character.length) {
      expansions.push({
        start: folded.length,
        end: folded.length + value.length,
        originalStart,
        originalEnd: originalStart + character.length,
      });
    }
    folded += value;
    originalStart += character.length;
  }
  return { folded, expansions };
}

function originalOffset(expansions: Expansion[], offset: number) {
  const expansion =
    expansions[
      firstTrue(expansions.length, (i) => expansions[i].start > offset) - 1
    ];
  if (!expansion) return offset;
  if (offset === expansion.start) return expansion.originalStart;
  if (offset < expansion.end) return -1; // Do not match only part of a folded code point.
  return expansion.originalEnd + offset - expansion.end;
}

function splitsCodePoint(text: string, offset: number) {
  const left = text.charCodeAt(offset - 1);
  const right = text.charCodeAt(offset);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

export function findReadingMatches(
  body: HTMLElement,
  term: string,
): { ranges: Range[]; limited: boolean } {
  const ranges: Range[] = [];
  if (!term) return { ranges, limited: false };
  const needle = foldText(term).folded;
  for (const run of textRuns(body)) {
    let length = 0;
    const ends = run.map((node) => (length += node.length));
    const text = run.map((node) => node.data).join("");
    const { folded, expansions } = foldText(text);
    let offset = 0;
    for (;;) {
      const at = folded.indexOf(needle, offset);
      if (at < 0) break;
      const end = at + needle.length;
      const startOffset = originalOffset(expansions, at);
      const endOffset = originalOffset(expansions, end);
      if (
        startOffset < 0 ||
        endOffset < 0 ||
        splitsCodePoint(text, startOffset) ||
        splitsCodePoint(text, endOffset)
      ) {
        offset = at + 1;
        continue;
      }
      if (ranges.length === matchLimit) return { ranges, limited: true };
      const startNode = firstTrue(ends.length, (i) => ends[i] > startOffset);
      const endNode = firstTrue(ends.length, (i) => ends[i] >= endOffset);
      const range = body.ownerDocument.createRange();
      range.setStart(run[startNode], startOffset - (ends[startNode - 1] ?? 0));
      range.setEnd(run[endNode], endOffset - (ends[endNode - 1] ?? 0));
      ranges.push(range);
      offset = end;
    }
  }
  return { ranges, limited: false };
}
