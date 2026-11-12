import { useState } from "react";
import { Download, Paperclip } from "lucide-react";
import type { Document } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { toast } from "sonner";
import {
  attachmentSize,
  downloadAttachment,
  loadAttachments,
  useAttachments,
  useLoadAttachments,
} from "./papers/attachments";

/** Download the unchanged source of a converted book without opening an editor. */
export function SourceFiles({ doc }: { doc: Document }) {
  useLoadAttachments(doc);
  const items = useAttachments((state) => state.items[doc.id]);
  const error = useAttachments((state) => state.errors[doc.id]);
  const [downloading, setDownloading] = useState(false);
  return (
    <section className="paper-attachments" aria-label="原文件与附件">
      <h3 className="flex items-center gap-1.5">
        <Paperclip className="size-3.5" />
        原文件与附件
      </h3>
      {error ? (
        <div role="alert" className="text-xs text-destructive">
          {error}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void loadAttachments(doc.id)}
          >
            重试
          </Button>
        </div>
      ) : !items ? (
        <p role="status" className="text-xs text-muted-foreground">
          正在读取附件…
        </p>
      ) : (
        items
          .filter((item) => item.kind === "file")
          .map((item) => (
            <div key={item.id} className="flex items-center gap-2 py-1">
              <span
                className="min-w-0 flex-1 truncate text-xs"
                title={item.filename}
              >
                {item.filename}
              </span>
              <span className="text-xs text-muted-foreground">
                {attachmentSize(item.size)}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`下载 ${item.filename}`}
                title="下载原文件"
                disabled={downloading}
                onClick={async () => {
                  setDownloading(true);
                  try {
                    await downloadAttachment(item);
                  } catch (error) {
                    toast.error((error as Error).message);
                  } finally {
                    setDownloading(false);
                  }
                }}
              >
                <Download />
              </Button>
            </div>
          ))
      )}
    </section>
  );
}
