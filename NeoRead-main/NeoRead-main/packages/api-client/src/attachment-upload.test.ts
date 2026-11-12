// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { uploadAttachment } from "./attachment-upload";
vi.mock("./diagnostics", () => ({ reportDiagnostic: vi.fn() }));
class UploadXHR {
  static current: UploadXHR;
  upload: {
    onprogress?: (event: {
      lengthComputable: boolean;
      loaded: number;
      total: number;
    }) => void;
  } = {};
  status = 0;
  responseText = "";
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn((_body: FormData) => {});
  abort = vi.fn(() => this.onabort?.());
  constructor() {
    UploadXHR.current = this;
  }
}
beforeEach(() => {
  vi.stubGlobal("XMLHttpRequest", UploadXHR);
});
afterEach(() => vi.unstubAllGlobals());
it("reports upload progress while waiting for an authenticated save response", async () => {
  const progress = vi.fn();
  const complete = vi.fn();
  const promise = uploadAttachment<{ id: string }>(
    "/api/documents/p/attachments",
    "test-token",
    new File(["pdf"], "supp.pdf"),
    { onProgress: progress },
  ).then(complete);
  const xhr = UploadXHR.current;
  expect(xhr.setRequestHeader).toHaveBeenCalledWith(
    "Authorization",
    "Bearer test-token",
  );
  expect(xhr.send.mock.calls[0][0]).toBeInstanceOf(FormData);
  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 10 });
  await Promise.resolve();
  expect(progress).toHaveBeenCalledWith(1);
  expect(complete).not.toHaveBeenCalled();
  xhr.status = 201;
  xhr.responseText = '{"id":"saved"}';
  xhr.onload?.();
  await promise;
  expect(complete).toHaveBeenCalledWith({ id: "saved" });
});
it("aborts an active upload and avoids sending an already cancelled upload", async () => {
  const controller = new AbortController();
  const promise = uploadAttachment(
    "/api/documents/p/attachments",
    "token",
    new File(["a"], "a.txt"),
    { signal: controller.signal },
  );
  const rejected = expect(promise).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await rejected;
  expect(UploadXHR.current.abort).toHaveBeenCalledOnce();
  const previous = UploadXHR.current;
  await expect(
    uploadAttachment(
      "/api/documents/p/attachments",
      "token",
      new File([], "a.txt"),
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(UploadXHR.current).toBe(previous);
});
it("preserves server error feedback and rejects malformed responses", async () => {
  const file = new File([], "a.txt");
  const failed = uploadAttachment(
    "/api/documents/p/attachments",
    "token",
    file,
  );
  const rejected = expect(failed).rejects.toThrow("论文已被删除");
  UploadXHR.current.status = 404;
  UploadXHR.current.responseText = '{"error":"论文已被删除"}';
  UploadXHR.current.onload?.();
  await rejected;
  const malformed = uploadAttachment(
    "/api/documents/p/attachments",
    "token",
    file,
  );
  const invalid = expect(malformed).rejects.toThrow("响应无效");
  UploadXHR.current.status = 200;
  UploadXHR.current.responseText = "oops";
  UploadXHR.current.onload?.();
  await invalid;
});
