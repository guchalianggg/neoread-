import { useRef, useState, type RefObject } from "react";
import { Button } from "@neoread/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@neoread/ui/components/popover";
import { ListTree } from "lucide-react";
import type { PhrasingContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
type Heading = { title: string; level: number; jump: () => void };

function inlineText(node: PhrasingContent): string {
  if (node.type === "break") return " ";
  if (node.type === "html") return "";
  if ("value" in node) return node.value;
  if ("alt" in node) return node.alt ?? "";
  return "children" in node ? node.children.map(inlineText).join("") : "";
}

function jumpToSource(field: HTMLTextAreaElement, start: number) {
  field.focus({ preventScroll: true });
  field.setSelectionRange(start, start);
  // Measure wrapped lines as well as hard line breaks without modifying the draft.
  const doc = field.ownerDocument;
  const style = getComputedStyle(field);
  const mirror = doc.createElement("div");
  mirror.style.cssText =
    "position:fixed;left:-9999px;top:0;visibility:hidden;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:break-word";
  mirror.style.width = `${field.clientWidth}px`;
  mirror.style.padding = style.padding;
  mirror.style.font = style.font;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.tabSize = style.tabSize;
  const marker = doc.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(field.value.slice(0, start), marker);
  doc.body.append(mirror);
  field.scrollTop = Math.max(0, marker.offsetTop - 12);
  mirror.remove();
}

function sourceHeadings(field: HTMLTextAreaElement) {
  const entries: Heading[] = [];
  // Parse textarea.value so offsets use its normalized line endings.
  visit(parser.parse(field.value), "heading", (node) => {
    const start = node.position?.start.offset;
    const title = node.children.map(inlineText).join("").trim();
    if (start === undefined || !title) return;
    entries.push({
      title,
      level: node.depth,
      jump: () => jumpToSource(field, start),
    });
  });
  return entries;
}

function richHeadings(root: HTMLDivElement | null) {
  const entries: Heading[] = [];
  for (const heading of root?.querySelectorAll(
    ".ProseMirror :is(h1, h2, h3, h4, h5, h6)",
  ) ?? []) {
    const copy = heading.cloneNode(true) as HTMLElement;
    for (const math of copy.querySelectorAll<HTMLElement>("[data-note-math]")) {
      math.replaceWith(math.dataset.value ?? "");
    }
    const title = copy.textContent?.trim();
    if (!title) continue;
    entries.push({
      title,
      level: Number(heading.tagName[1]),
      jump: () => heading.scrollIntoView({ block: "start", inline: "nearest" }),
    });
  }
  return entries;
}

export function SourceDocumentOutline({
  rich,
  source,
  disabled,
}: {
  rich: RefObject<HTMLDivElement | null>;
  source: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Heading[]>([]);
  const jumpedToSource = useRef(false);
  const baseLevel = entries.reduce(
    (min, entry) => Math.min(min, entry.level),
    6,
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          jumpedToSource.current = false;
          setEntries(
            source.current
              ? sourceHeadings(source.current)
              : richHeadings(rich.current),
          );
        } else {
          setEntries([]);
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={<Button variant="ghost" size="xs" />}
        disabled={disabled}
      >
        <ListTree />
        目录
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(19rem,calc(100vw-2rem))]"
        finalFocus={() => !jumpedToSource.current}
      >
        <PopoverTitle>文档目录</PopoverTitle>
        {entries.length ? (
          <nav
            aria-label="文档目录"
            className="max-h-[min(60dvh,24rem)] overflow-y-auto"
          >
            <ul>
              {entries.map(({ title, level, jump }, index) => (
                <li key={index}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start whitespace-normal py-1.5 text-start [overflow-wrap:anywhere]"
                    style={{
                      paddingInlineStart: `${0.5 + (level - baseLevel) * 0.65}rem`,
                    }}
                    onClick={() => {
                      jumpedToSource.current = !!source.current;
                      jump();
                      setOpen(false);
                      setEntries([]);
                    }}
                  >
                    {title}
                  </Button>
                </li>
              ))}
            </ul>
          </nav>
        ) : (
          <p className="text-muted-foreground">未找到可导航的标题。</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
