import { FileText, Link, Paperclip, ArrowLeft } from "lucide-react";
import type { Document } from "@neoread/core";
import type { PaperAttachment } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import { TableCell } from "@neoread/ui/components/table";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@neoread/ui/components/context-menu";
import { usePaperUI } from "./state";
import {
  attachmentSize,
  downloadAttachment,
  loadAttachments,
  openAttachment,
  toggleAttachments,
  useAttachments,
  useLoadAttachments,
} from "./attachments";
import { PaperAttachments, AttachmentUploads } from "./PaperAttachments";
import { toast } from "sonner";
import { useAttachmentDrop } from "./attachment-drop";
import { useClickIntent } from "../DetailSheet";

export function AttachmentRows({
  doc,
  colSpan,
  openDocument,
}: {
  doc: Document;
  colSpan?: number;
  openDocument: (doc: Document) => void;
}) {
  useLoadAttachments(doc);
  const items = useAttachments((s) => s.items[doc.id]);
  const error = useAttachments((s) => s.errors[doc.id]);
  const selected = useAttachments((s) => s.selected);
  const selectedPaper = usePaperUI((s) => s.selectedId);
  const batch = useAttachments((s) => s.uploads[doc.id]);
  const { armed, ...dropHandlers } = useAttachmentDrop(doc, true);
  const clickIntent = useClickIntent(`${selectedPaper}:${selected?.id}`);
  if (items?.length === 0 && !batch && !error) return null;
  const select = (item: PaperAttachment | null) => {
    usePaperUI.getState().select(doc.id);
    useAttachments.setState({ selected: item });
  };
  const row = (item: PaperAttachment | null) => {
    const title = item?.title || "正文";
    const content = (
      <>
        <span className="paper-child-icon">
          {item?.kind === "link" ? (
            <Link />
          ) : item ? (
            <Paperclip />
          ) : (
            <FileText />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="paper-child-meta">
          {item?.kind === "file"
            ? attachmentSize(item.size)
            : item
              ? "链接"
              : (doc.sourceFormat || doc.type).toUpperCase()}
        </span>
      </>
    );
    const key = item?.id || "primary";
    const open = () => {
      clickIntent.cancel();
      if (item) openAttachment(doc, item);
      else openDocument(doc);
    };
    return (
      <ContextMenu key={key}>
        <ContextMenuTrigger
          render={colSpan ? <tr /> : <div />}
          role={colSpan ? undefined : "listitem"}
          className="paper-child-row"
          data-attachment-drop={armed || undefined}
          {...dropHandlers}
          data-attachment-row={key}
          data-parent-id={doc.id}
          data-selected={
            (!!item && selected?.id === item.id) ||
            clickIntent.pending === `${doc.id}:${key}` ||
            undefined
          }
          tabIndex={0}
          aria-label={`${title}，${doc.title}的附件`}
          onClick={(event) => {
            // The second click of a double click opens instead, and an open
            // sheet switches at once; otherwise wait out the double click.
            if (event.detail > 1) return;
            if (usePaperUI.getState().selectedId) select(item);
            else clickIntent.defer(`${doc.id}:${key}`, () => select(item));
          }}
          onDoubleClick={open}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              open();
            }
            if (event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              select(item);
            }
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              event.stopPropagation();
              toggleAttachments(doc.id, false);
              select(null);
              document
                .querySelector<HTMLElement>(`[data-paper-id="${doc.id}"]`)
                ?.focus();
            }
          }}
        >
          {colSpan ? (
            <TableCell colSpan={colSpan}>
              <div className="paper-child-content">{content}</div>
            </TableCell>
          ) : (
            <div className="paper-child-content">{content}</div>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={open}>
            {item?.kind === "link" ? "打开链接" : "打开"}
          </ContextMenuItem>
          {item?.kind === "file" && (
            <ContextMenuItem
              onClick={() =>
                void downloadAttachment(item).catch((e: Error) =>
                  toast.error(e.message),
                )
              }
            >
              下载文件
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => select(item)}>
            查看详情
          </ContextMenuItem>
          {item && (
            <>
              <ContextMenuItem
                onClick={() => {
                  select(item);
                  useAttachments.setState({
                    managing: { item, action: "rename" },
                  });
                }}
              >
                重命名
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                onClick={() => {
                  select(item);
                  useAttachments.setState({
                    managing: { item, action: "remove" },
                  });
                }}
              >
                移除附件…
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  };
  const status = (
    <div
      className="paper-child-status"
      data-attachment-drop={armed || undefined}
      {...(!colSpan ? dropHandlers : {})}
    >
      {error ? (
        <>
          <span role="alert">{error}</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void loadAttachments(doc.id)}
          >
            重试
          </Button>
        </>
      ) : !items ? (
        <span role="status">正在读取附件…</span>
      ) : null}
      <AttachmentUploads doc={doc} />
    </div>
  );
  return (
    <>
      {row(null)}
      {items?.map(row)}
      {(!items || error || batch) &&
        (colSpan ? (
          <tr data-attachment-drop={armed || undefined} {...dropHandlers}>
            <TableCell colSpan={colSpan}>{status}</TableCell>
          </tr>
        ) : (
          status
        ))}
    </>
  );
}

export function AttachmentDetail({
  doc,
  item,
}: {
  doc: Document;
  item: PaperAttachment;
}) {
  return (
    <aside className="paper-detail" aria-label="附件详情">
      <div className="paper-detail-body">
        <Button
          size="sm"
          variant="ghost"
          className="justify-start"
          onClick={() => useAttachments.setState({ selected: null })}
        >
          <ArrowLeft />
          返回论文详情
        </Button>
        <h2 className="break-words text-base font-medium">{item.title}</h2>
        <p className="truncate text-xs text-muted-foreground" title={doc.title}>
          {doc.title}
        </p>
        <dl className="paper-fields">
          <dt>类型</dt>
          <dd className="paper-field-static">
            {item.kind === "link" ? "网页链接" : item.mediaType || "文件"}
          </dd>
          {item.kind === "file" && (
            <>
              <dt>文件名</dt>
              <dd className="paper-field-static break-all">{item.filename}</dd>
              <dt>大小</dt>
              <dd className="paper-field-static">
                {attachmentSize(item.size)}
              </dd>
            </>
          )}
          <dt>添加时间</dt>
          <dd className="paper-field-static">
            {new Date(item.createdAt).toLocaleString("zh-CN")}
          </dd>
        </dl>
        <PaperAttachments key={item.id} doc={doc} only={item} />
      </div>
    </aside>
  );
}
