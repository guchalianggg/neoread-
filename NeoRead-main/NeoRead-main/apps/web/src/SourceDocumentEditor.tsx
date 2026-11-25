import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "@neoread/api";
import type { Document } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@neoread/ui/components/dropdown-menu";
import {
  ArrowLeft,
  BookOpen,
  Download,
  Pencil,
  Save,
  Settings,
} from "lucide-react";
import { PaperNoteRichEditor } from "./PaperNoteRichEditor";
import { SourceDocumentReader } from "./SourceDocumentReader";
import { EditableSpreadsheet } from "./EditableSpreadsheet";
import { canRefreshSourceEdit, getSourceEditStore } from "./source-edit-state";
import { useLinkedSourceSync } from "./use-linked-source-sync";
import { downloadBlob, exportCancelled, fileTitle } from "./download";
import { exportMarkdownFile, type ExportFormat } from "./document-export";
import { reportDiagnostic } from "./diagnostics";
import "./source-document-editor.css";

export type SourceDocumentEditorProps = {
  document: Document;
  active?: boolean;
  onBack: () => void;
  onSettings?: () => void;
};

export function sourceEditDownloadName(filename: string): string {
  return filename.replace(/\.xls$/i, ".xlsx").replace(/\.doc$/i, ".docx");
}

function markdownCopyName(filename: string): string {
  const stem = fileTitle(
    filename
      .trim()
      .replace(/\.(?:md|markdown)$/i, "")
      .replace(/\p{Cc}/gu, "-"),
  ).replace(/[. ]+$/, "");
  // Windows reserves device names even when followed by a dot and extension.
  const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
  return `${reserved.test(stem) ? "_" : ""}${stem || "Markdown"}-副本`;
}

const linkedSourceStatus = {
  current: "已链接源文件",
  updated: "已从源文件更新",
  missing: "找不到源文件，已保留当前副本。",
  conflict: "源文件与书库副本有冲突，已保留当前副本。",
  busy: "源文件同步处理中",
  failed: "源文件同步未完成，已保留当前副本。",
};

// Key the inner editor even if a caller reuses one workspace for several tabs.
export function SourceDocumentEditor(props: SourceDocumentEditorProps) {
  return <SourceDocumentEditorSession key={props.document.id} {...props} />;
}

function SourceDocumentEditorSession({
  document: doc,
  active = true,
  onBack,
  onSettings,
}: SourceDocumentEditorProps) {
  const store = useMemo(() => getSourceEditStore(doc.id), [doc.id]);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [editing, setEditing] = useState(false);
  const [readingBody, setReadingBody] = useState("");
  const markdownExport = useRef<AbortController | null>(null);
  const exportHintId = useId();
  const snapshot = state.snapshot;
  const disabled = !snapshot || state.loading || downloading;
  useEffect(() => {
    void store.load();
    return store.registerCloseGuard();
  }, [store]);
  // Closing or switching tabs abandons preparation/printing for this tab.
  useEffect(() => () => markdownExport.current?.abort(), [active]);
  useEffect(() => {
    if (!active) return;
    const save = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "s"
      )
        return;
      if (event.defaultPrevented) return;
      // Consume recognized saves even when repeated/composing/disabled, never save the page.
      event.preventDefault();
      event.stopPropagation();
      if (
        event.repeat ||
        event.isComposing ||
        disabled ||
        state.saving ||
        state.conflict
      )
        return;
      void store.flush().catch(() => {
        /* The store exposes save errors without dropping input. */
      });
    };
    window.addEventListener("keydown", save);
    return () => window.removeEventListener("keydown", save);
  }, [active, disabled, state.saving, state.conflict, store]);
  const download = async () => {
    if (disabled || state.conflict || downloading) return;
    setDownloading(true);
    setDownloadError("");
    try {
      await store.flush();
      const blob = await api.downloadSourceEdit(doc.id);
      downloadBlob(
        blob,
        sourceEditDownloadName(store.getSnapshot().snapshot!.filename),
      );
    } catch {
      setDownloadError("下载未完成；请先处理保存错误后重试。草稿仍保留。");
      try {
        reportDiagnostic({
          event: "source_edit.download_failed",
          level: "warn",
          detail: "download_not_requested",
        });
      } catch {
        /* Diagnostics cannot block recovery. */
      }
    } finally {
      setDownloading(false);
    }
  };
  const reload = () => {
    if (state.saving || state.loading) return;
    if (
      state.dirty &&
      !window.confirm(
        "重新加载将丢弃当前未保存草稿，并读取服务器最新版本。确定继续吗？",
      )
    )
      return;
    void store.reloadConfirmed();
  };
  const kind = snapshot?.kind ?? doc.sourceFormat;
  const spreadsheet = kind === "xls" || kind === "xlsx";
  const word = kind === "doc" || kind === "docx";
  const linkedSourceView =
    active && !editing && (word || kind === "md" || kind === "markdown");
  const canCheckLinkedSource =
    linkedSourceView && !downloading && canRefreshSourceEdit(state);
  const linkedSync = useLinkedSourceSync(doc.id, store, canCheckLinkedSource);
  const markdown = kind === "md" || kind === "markdown";
  const exportConflict = state.conflict || linkedSync.status === "conflict";
  const canExportMarkdown =
    active && !downloading && !exportConflict && canRefreshSourceEdit(state);
  const exportHint = exportConflict
    ? "请先处理冲突再导出。"
    : state.dirty && !state.saving
      ? "请先保存修改再导出。"
      : "";
  const exportCopy = async (format: ExportFormat) => {
    if (
      !canExportMarkdown ||
      !snapshot ||
      markdownExport.current ||
      store.getSnapshot() !== state
    )
      return;
    // Use the committed body from this render, not a new fetch or a draft flush.
    const controller = new AbortController();
    markdownExport.current = controller;
    setDownloading(true);
    setDownloadError("");
    try {
      await exportMarkdownFile(
        snapshot.content ?? "",
        markdownCopyName(snapshot.filename),
        format,
        controller.signal,
      );
    } catch (error) {
      if (exportCancelled(error, controller.signal)) return;
      setDownloadError("导出未完成，请重试。");
      // The shared PDF pipeline already reports its failures.
      if (format === "markdown") {
        try {
          reportDiagnostic({
            event: "source_edit.markdown_export_failed",
            level: "error",
            detail: "markdown_delivery_failed",
          });
        } catch {
          /* Diagnostics cannot block recovery. */
        }
      }
    } finally {
      markdownExport.current = null;
      setDownloading(false);
    }
  };
  const status = state.loading
    ? "读取中"
    : state.saving
      ? "保存中"
      : state.dirty
        ? "未保存"
        : snapshot
          ? "已保存"
          : "未读取";
  return (
    <section
      className="source-document-editor"
      data-layout={spreadsheet ? "spreadsheet" : "prose"}
      aria-label="源文档编辑器"
      aria-hidden={!active}
    >
      <header className="source-edit-toolbar">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft />
          返回书库
        </Button>
        <h1 title={snapshot?.filename ?? doc.title}>
          {snapshot?.filename ?? doc.title}
        </h1>
        <span
          className="source-edit-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {status}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || state.saving || !state.dirty || state.conflict}
          onClick={() => {
            void store.flush().catch(() => {});
          }}
        >
          <Save />
          保存
        </Button>
        {!spreadsheet && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              if (!editing) setReadingBody(snapshot?.content ?? "");
              setEditing(!editing);
            }}
          >
            {editing ? <BookOpen /> : <Pencil />}
            {editing ? "返回阅读" : "编辑"}
          </Button>
        )}
        {markdown ? (
          active && (
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={!canExportMarkdown}
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-busy={downloading}
                    aria-describedby={exportHint ? exportHintId : undefined}
                  />
                }
              >
                <Download />
                {downloading ? "导出中" : "导出"}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuItem
                  disabled={!canExportMarkdown}
                  onClick={() => void exportCopy("markdown")}
                >
                  Markdown (.md)
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canExportMarkdown}
                  onClick={() => void exportCopy("pdf")}
                >
                  {window.neoreadDesktop?.markdownPDF ? "PDF" : "PDF（打印）"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || state.saving || state.conflict}
            onClick={() => {
              void download();
            }}
          >
            <Download />
            {downloading ? "下载中" : "下载"}
          </Button>
        )}
        {onSettings && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="设置"
            onClick={onSettings}
          >
            <Settings />
          </Button>
        )}
      </header>
      <div className="source-edit-notice">
        <span>编辑副本，原件保留。</span>
        {markdown && exportHint && <span id={exportHintId}>{exportHint}</span>}
        {word && (
          <span>
            {kind === "doc" ? "DOC 将保存为 DOCX。" : "保存为 DOCX。"}
            仅支持基础标题、列表、表格；不保留复杂版式或宏。
          </span>
        )}
        {spreadsheet && (
          <span>
            {kind === "xls" ? "XLS 将保存为 XLSX。" : "保存为 XLSX。"}
            按文本编辑，不计算公式、不加载外链；不保证保留公式、图表、复杂格式或宏。
          </span>
        )}
        {linkedSourceView && linkedSync.status && (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span role="status">{linkedSourceStatus[linkedSync.status]}</span>
            <Button
              variant="ghost"
              size="xs"
              disabled={!canCheckLinkedSource || linkedSync.checking}
              onClick={linkedSync.retry}
            >
              检查源文件
            </Button>
          </span>
        )}
      </div>
      {(state.error || downloadError) && (
        <div className="source-edit-error" role="alert">
          <span>{state.error || downloadError}</span>
          {state.conflict ? (
            <Button
              variant="outline"
              size="sm"
              disabled={state.loading || state.saving}
              onClick={reload}
            >
              重新加载最新版本
            </Button>
          ) : (
            state.error && (
              <Button
                variant="outline"
                size="sm"
                disabled={state.loading || state.saving}
                onClick={() => {
                  if (!snapshot) void store.load();
                  else if (state.dirty) void store.flush().catch(() => {});
                  else reload();
                }}
              >
                重试
              </Button>
            )
          )}
        </div>
      )}
      <div
        className="source-edit-content"
        data-reading={!!snapshot && !spreadsheet && !editing}
        aria-busy={state.loading}
      >
        {snapshot ? (
          spreadsheet ? (
            <EditableSpreadsheet
              sheets={snapshot.sheets ?? []}
              disabled={disabled}
              onChange={store.editSheets}
            />
          ) : (
            <>
              <SourceDocumentReader
                documentId={doc.id}
                body={editing ? readingBody : (snapshot.content ?? "")}
                active={active && !editing}
                hidden={editing}
              />
              {editing && (
                <PaperNoteRichEditor
                  body={snapshot.content ?? ""}
                  outline={active}
                  ariaLabel={word ? "编辑 Word 文档" : "编辑 Markdown 文档"}
                  placeholder="编辑正文、标题、列表和表格…"
                  disabled={disabled}
                  onChange={store.editContent}
                  onBlur={() => {}}
                />
              )}
            </>
          )
        ) : (
          <p className="source-edit-placeholder">
            {state.loading ? "正在读取文档…" : "文档尚未读取。"}
          </p>
        )}
      </div>
    </section>
  );
}
