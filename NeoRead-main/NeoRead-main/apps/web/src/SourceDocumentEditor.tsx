import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "@neoread/api";
import type { Document } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { ArrowLeft, Download, Save, Settings } from "lucide-react";
import { PaperNoteRichEditor } from "./PaperNoteRichEditor";
import { EditableSpreadsheet } from "./EditableSpreadsheet";
import { getSourceEditStore } from "./source-edit-state";
import { downloadBlob } from "./download";
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
  const snapshot = state.snapshot;
  const disabled = !snapshot || state.loading || downloading;
  useEffect(() => {
    void store.load();
    return store.registerCloseGuard();
  }, [store]);
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
  const spreadsheet = snapshot?.kind === "xls" || snapshot?.kind === "xlsx";
  const word = snapshot?.kind === "doc" || snapshot?.kind === "docx";
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
        {word && (
          <span>
            {snapshot.kind === "doc" ? "DOC 将保存为 DOCX。" : "保存为 DOCX。"}
            仅支持基础标题、列表、表格；不保留复杂版式或宏。
          </span>
        )}
        {spreadsheet && (
          <span>
            {snapshot.kind === "xls" ? "XLS 将保存为 XLSX。" : "保存为 XLSX。"}
            按文本编辑，不计算公式、不加载外链；不保证保留公式、图表、复杂格式或宏。
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
      <div className="source-edit-content" aria-busy={state.loading}>
        {snapshot ? (
          spreadsheet ? (
            <EditableSpreadsheet
              sheets={snapshot.sheets ?? []}
              disabled={disabled}
              onChange={store.editSheets}
            />
          ) : (
            <PaperNoteRichEditor
              body={snapshot.content ?? ""}
              ariaLabel={word ? "编辑 Word 文档" : "编辑 Markdown 文档"}
              placeholder="编辑正文、标题、列表和表格…"
              disabled={disabled}
              onChange={store.editContent}
              onBlur={() => {}}
            />
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
