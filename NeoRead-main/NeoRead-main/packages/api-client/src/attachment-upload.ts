import { reportDiagnostic } from "./diagnostics";

export interface AttachmentUploadOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** Upload progress is separate from the server's successful save response. */
export function uploadAttachment<T>(
  path: string,
  token: string,
  file: File,
  options: AttachmentUploadOptions = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("已取消上传", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (error?: Error, value?: T) => {
      options.signal?.removeEventListener("abort", abort);
      reportDiagnostic({
        level: error ? "error" : "info",
        event: "api.finish",
        route: "/api/documents/:id/attachments",
        method: "POST",
        status: xhr.status || undefined,
      });
      if (error) reject(error);
      else resolve(value!);
    };
    xhr.open("POST", path);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0)
        options.onProgress?.(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        finish(new Error("附件上传响应无效，请刷新附件列表确认结果"));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300)
        finish(new Error(data.error || `附件上传失败 (${xhr.status})`));
      else finish(undefined, data);
    };
    xhr.onerror = () => finish(new Error("附件上传连接中断，请重试"));
    xhr.onabort = () => finish(new DOMException("已取消上传", "AbortError"));
    options.signal?.addEventListener("abort", abort, { once: true });
    const body = new FormData();
    body.append("file", file);
    xhr.send(body);
  });
}
