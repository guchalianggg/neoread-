import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@neoread/ui/components/popover";
import {
  ChevronDown,
  ChevronUp,
  ListTree,
  Pin,
  PinOff,
  Search,
  X,
} from "lucide-react";
import { SourceReadingBody } from "./SourceReadingBody";
import {
  findReadingMatches,
  indexReadingContent,
  readingPoint,
  resolveReadingAnchor,
  type ReadingIndex,
} from "./source-reading-navigation";
import {
  readingWidths,
  useSourceReadingPreferences,
} from "./useSourceReadingPreferences";

const widthLabels = { narrow: "窄", standard: "标准", wide: "宽" };

function Contents({
  headings,
  current,
  jump,
}: {
  headings: ReadingIndex["headings"];
  current: HTMLElement | null;
  jump: (heading: HTMLElement) => void;
}) {
  const base = headings.reduce((min, item) => Math.min(min, item.level), 6);
  if (!headings.length)
    return (
      <p className="px-2 text-sm text-muted-foreground">未找到可导航的标题。</p>
    );
  return (
    <nav aria-label="文档目录" className="source-read-outline-list">
      <ul>
        {headings.map(({ element, title, level }, index) => (
          <li key={index}>
            <Button
              variant={current === element ? "secondary" : "ghost"}
              size="sm"
              aria-current={current === element ? "location" : undefined}
              style={{
                paddingInlineStart: `${0.5 + (level - base) * 0.65}rem`,
              }}
              onClick={() => jump(element)}
            >
              {title}
            </Button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const noMatches = { ranges: [] as Range[], limited: false };

export function SourceDocumentReader({
  documentId,
  body,
  active,
  hidden,
}: {
  documentId: string;
  body: string;
  active: boolean;
  hidden?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const find = useRef<HTMLInputElement>(null);
  const findButton = useRef<HTMLButtonElement>(null);
  const [index, setIndex] = useState<ReadingIndex>();
  const [current, setCurrent] = useState<HTMLElement | null>(null);
  const [wide, setWide] = useState(false);
  const [popup, setPopup] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [matches, setMatches] = useState(noMatches);
  const [result, setResult] = useState(0);
  const preferences = useSourceReadingPreferences(documentId);
  const effectivePinned = preferences.pinned && wide;
  const relayout = useRef(false);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  useLayoutEffect(() => {
    const update = () => setWide((host.current?.clientWidth ?? 0) >= 896);
    update();
    if (typeof ResizeObserver === "undefined" || !host.current) return;
    const observer = new ResizeObserver(update);
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (article.current) setIndex(indexReadingContent(article.current));
  }, [body]);

  const move = (top: number) => {
    const area = viewport.current;
    // Align the semantic block with the reading probe, below the viewport border.
    if (area)
      area.scrollTop += top - area.getBoundingClientRect().top - area.clientTop;
  };
  const updatePoint = (
    next: ReadingIndex,
    area: HTMLDivElement,
    save: boolean,
  ) => {
    const point = readingPoint(next, area);
    setCurrent(point?.heading ?? null);
    if (save && point)
      preferencesRef.current.change({ position: point.anchor });
  };
  useLayoutEffect(() => {
    if (!active || !preferences.ready || !index || !viewport.current) return;
    relayout.current = false;
    const area = viewport.current;
    const anchor = preferencesRef.current.current.current.position;
    if (anchor) {
      const target = resolveReadingAnchor(index, anchor);
      if (target) move(target.getBoundingClientRect().top);
    }
    updatePoint(index, area, false);
  }, [active, index, preferences.ready]);
  useLayoutEffect(() => {
    if (!relayout.current || !index || !viewport.current) return;
    relayout.current = false;
    const anchor = preferencesRef.current.current.current.position;
    const target = anchor && resolveReadingAnchor(index, anchor);
    if (target) move(target.getBoundingClientRect().top);
  }, [preferences.width, effectivePinned, index]);
  useEffect(() => {
    if (!active || !index || !preferences.ready || !viewport.current) return;
    const area = viewport.current;
    let frame: number | undefined;
    const onScroll = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        updatePoint(index, area, true);
      });
    };
    area.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      area.removeEventListener("scroll", onScroll);
      if (frame !== undefined) cancelAnimationFrame(frame);
      preferencesRef.current.flush();
    };
  }, [active, index, preferences.ready]);
  useEffect(() => {
    if (active) return;
    setPopup(false);
    setFindOpen(false);
    setTerm("");
  }, [active]);

  const jump = (heading: HTMLElement) => {
    move(heading.getBoundingClientRect().top);
    setCurrent(heading);
    if (index && viewport.current) updatePoint(index, viewport.current, true);
    setPopup(false);
  };
  const resize = (patch: Parameters<typeof preferences.change>[0]) => {
    if (index && viewport.current) updatePoint(index, viewport.current, true);
    relayout.current = true;
    preferences.change(patch);
    setPopup(false);
  };

  function closeFind() {
    setFindOpen(false);
    setTerm("");
    requestAnimationFrame(() => {
      if (findButton.current?.offsetParent)
        findButton.current.focus({ preventScroll: true });
    });
  }
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        setFindOpen(true);
        find.current?.focus();
        find.current?.select();
      } else if (findOpen && event.key === "Escape" && !popup) {
        event.preventDefault();
        closeFind();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, findOpen, popup]);
  useEffect(() => {
    if (active && findOpen) {
      find.current?.focus();
      find.current?.select();
    }
  }, [active, findOpen]);
  useLayoutEffect(() => {
    if (active && findOpen && term.trim() && article.current) {
      setMatches(findReadingMatches(article.current, term));
    } else setMatches(noMatches);
    setResult(0);
  }, [active, findOpen, term, index]);
  useLayoutEffect(() => {
    if (!active || !findOpen || !matches.ranges.length) return;
    const registry = typeof CSS === "undefined" ? undefined : CSS.highlights;
    const range = matches.ranges[result];
    if (!range) return;
    if (registry && typeof Highlight !== "undefined") {
      registry.set("neoread-source-find", new Highlight(...matches.ranges));
      registry.set("neoread-source-find-current", new Highlight(range));
    }
    const rect = range.getBoundingClientRect?.();
    if (rect && viewport.current) {
      const area = viewport.current.getBoundingClientRect();
      if (rect.top < area.top || rect.bottom > area.bottom) move(rect.top);
      const table = range.startContainer.parentElement?.closest<HTMLElement>(
        ".source-read-table-scroll",
      );
      if (table) {
        const frame = table.getBoundingClientRect();
        if (rect.left < frame.left || rect.right > frame.right)
          table.scrollLeft += rect.left - frame.left - 8;
      }
    }
    return () => {
      registry?.delete("neoread-source-find");
      registry?.delete("neoread-source-find-current");
    };
  }, [active, findOpen, matches, result]);

  function step(delta: number) {
    if (matches.ranges.length)
      setResult(
        (value) =>
          (value + delta + matches.ranges.length) % matches.ranges.length,
      );
  }
  const contents = (
    <Contents headings={index?.headings ?? []} current={current} jump={jump} />
  );
  return (
    <div ref={host} className="source-read-workspace" hidden={hidden}>
      <div className="source-read-toolbar">
        {!effectivePinned && (
          <Popover open={popup} onOpenChange={setPopup}>
            <PopoverTrigger render={<Button size="sm" variant="ghost" />}>
              <ListTree />
              目录
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-[min(19rem,calc(100vw-2rem))] max-h-[min(60dvh,24rem)]"
            >
              <div className="source-read-outline-header">
                <PopoverTitle>文档目录</PopoverTitle>
                {wide && (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="固定目录"
                    title="固定目录"
                    disabled={!preferences.ready}
                    onClick={() => resize({ pinned: true })}
                  >
                    <Pin />
                  </Button>
                )}
              </div>
              {contents}
            </PopoverContent>
          </Popover>
        )}
        <div role="group" aria-label="正文宽度" className="source-read-width">
          {readingWidths.map((width) => (
            <Button
              key={width}
              size="xs"
              variant={preferences.width === width ? "secondary" : "ghost"}
              aria-pressed={preferences.width === width}
              disabled={!preferences.ready}
              onClick={() => {
                if (preferences.width !== width) resize({ width });
              }}
            >
              {widthLabels[width]}
            </Button>
          ))}
        </div>
        {!findOpen ? (
          <Button
            ref={findButton}
            size="sm"
            variant="ghost"
            onClick={() => setFindOpen(true)}
          >
            <Search />
            查找
          </Button>
        ) : (
          <form
            role="search"
            aria-label="文内查找"
            className="source-read-find"
            onSubmit={(event) => event.preventDefault()}
          >
            <Input
              ref={find}
              aria-label="查找正文"
              placeholder="查找正文"
              value={term}
              maxLength={160}
              onChange={(event) => setTerm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  step(event.shiftKey ? -1 : 1);
                }
              }}
            />
            <output aria-live="polite">
              {matches.ranges.length
                ? `${result + 1} / ${matches.ranges.length}${matches.limited ? "+" : ""}`
                : term.trim()
                  ? "无结果"
                  : ""}
            </output>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="上一处"
              disabled={!matches.ranges.length}
              onClick={() => step(-1)}
            >
              <ChevronUp />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="下一处"
              disabled={!matches.ranges.length}
              onClick={() => step(1)}
            >
              <ChevronDown />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="关闭查找"
              onClick={closeFind}
            >
              <X />
            </Button>
          </form>
        )}
      </div>
      <div className="source-read-layout">
        {effectivePinned && (
          <aside className="source-read-sidebar">
            <div className="source-read-outline-header">
              <span>目录</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="取消固定目录"
                title="取消固定目录"
                onClick={() => resize({ pinned: false })}
              >
                <PinOff />
              </Button>
            </div>
            {contents}
          </aside>
        )}
        <div
          ref={viewport}
          className="source-read-viewport"
          tabIndex={0}
          aria-label="阅读正文"
          role="region"
        >
          <article
            ref={article}
            data-width={preferences.width}
            className="source-read-article message-markdown"
          >
            <SourceReadingBody body={body} />
          </article>
        </div>
      </div>
    </div>
  );
}
