import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";
import type { Root } from "mdast";
import { Button } from "@neoread/ui/components/button";
import { Maximize2, Minimize2 } from "lucide-react";
import MathFormula from "./chat/MathFormula";
import "./chat/markdown.css";

function remarkSourceBreaks() {
  return (root: Root) => {
    visit(root, "html", (node, index, parent) => {
      if (
        parent?.type !== "root" &&
        index !== undefined &&
        parent &&
        /^<br\s*\/?\s*>$/i.test(node.value)
      ) {
        Object.assign(node, { type: "break" });
      }
    });
  };
}

function ReadingTable({ children }: ComponentProps<"table">) {
  const scroll = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const measure = () => {
      if (!expanded) setWide(element.scrollWidth > element.clientWidth + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [expanded]);
  return (
    <div className="source-read-table" data-expanded={expanded}>
      {(wide || expanded) && (
        <div className="source-read-table-actions" data-reading-ignore>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
            {expanded ? "还原表格宽度" : "展开表格"}
          </Button>
        </div>
      )}
      <div
        className="source-read-table-scroll"
        ref={scroll}
        tabIndex={wide || expanded ? 0 : undefined}
        aria-label={wide || expanded ? "可横向滚动的表格" : undefined}
        role={wide || expanded ? "region" : undefined}
      >
        <table>{children}</table>
      </div>
    </div>
  );
}

const components: Components = {
  // Source documents are local and untrusted. Preserve labels, but never load
  // referenced files or activate external destinations through the reader.
  a: ({ children }) => <span className="source-read-link">{children}</span>,
  img: ({ alt }) => <span>{alt ? `[${alt}]` : "[图片]"}</span>,
  table: ReadingTable,
  pre: ({ node, children }) =>
    node?.children.some(
      (child) =>
        child.type === "element" &&
        Array.isArray(child.properties.className) &&
        child.properties.className.includes("math-display"),
    ) ? (
      <div>{children}</div>
    ) : (
      <pre>{children}</pre>
    ),
  code: ({ className, children }) => {
    const classes = className?.split(/\s+/) ?? [];
    return classes.includes("math-display") ||
      classes.includes("math-inline") ? (
      <MathFormula
        value={String(children).trim()}
        display={classes.includes("math-display")}
      />
    ) : (
      <code className={className}>{children}</code>
    );
  },
};

export const SourceReadingBody = memo(function SourceReadingBody({
  body,
}: {
  body: string;
}) {
  return (
    <Markdown
      components={components}
      remarkPlugins={[remarkGfm, remarkMath, remarkSourceBreaks]}
      skipHtml
    >
      {body}
    </Markdown>
  );
});
