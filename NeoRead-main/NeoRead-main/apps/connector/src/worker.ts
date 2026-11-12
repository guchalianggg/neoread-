/// <reference types="chrome" />
import type { Candidate } from "./detect";
import {
  clearCNKIRequestRule,
  ConnectorError,
  downloadPDF,
  readCNKIPage,
} from "./download";
// Remove a rule left by an interrupted service worker before handling requests.
const ready = clearCNKIRequestRule().then(
  () => null,
  () => "无法初始化知网下载规则，请重新加载插件",
);
const bridge = "http://127.0.0.1:17841";
type Result = {
  ok: boolean;
  error?: string;
  code?: string;
  pages?: number;
  warnings?: string[];
  document?: { id: string; title: string };
};
async function save(
  candidate: Candidate,
  folders: string[],
  tags: string[],
  allowLarge = false,
  library: "papers" | "books" = "papers",
): Promise<Result> {
  const { secret } = await chrome.storage.local.get("secret");
  if (!secret)
    return { ok: false, error: "请先打开 NeoRead 后重新打开插件" };
  const blob = await downloadPDF(candidate);
  const form = new FormData();
  form.append("library", library);
  form.append("pdf", blob, "paper.pdf");
  form.append("metadata", JSON.stringify(candidate.metadata));
  form.append("sourceUrl", candidate.sourceUrl);
  form.append("snapshot", candidate.snapshot);
  form.append("tags", JSON.stringify(tags));
  form.append("folders", JSON.stringify(folders));
  if (allowLarge) form.append("allowLarge", "1");
  let response: Response;
  try {
    response = await fetch(bridge + "/v1/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: form,
    });
  } catch {
    return {
      ok: false,
      error: "无法连接 NeoRead，请确认桌面应用正在运行",
    };
  }
  const data = await response
    .json()
    .catch(() => ({ error: `收录失败 (${response.status})` }));
  return response.ok
    ? { ok: true, document: data.document, warnings: data.warnings }
    : {
        ok: false,
        error: data.error || "收录失败",
        code: data.code,
        pages: data.pages,
      };
}
chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    const m = message as {
      type?: string;
      url?: string;
      sourceUrl?: string;
      candidate?: Candidate;
      folders?: string[];
      tags?: string[];
      allowLarge?: boolean;
      library?: "papers" | "books";
    };
    if (m?.type !== "save" && m?.type !== "cnki-page") return;
    void (async () => {
      const initializationError = await ready;
      if (initializationError)
        throw new ConnectorError("connector-init", initializationError);
      if (m.type === "cnki-page" && m.url && m.sourceUrl) {
        return { ok: true, ...(await readCNKIPage(m.url, m.sourceUrl)) };
      }
      if (!m.candidate)
        throw new ConnectorError("invalid-request", "收录请求缺少论文信息");
      return save(
        m.candidate,
        m.folders || [],
        m.tags || [],
        !!m.allowLarge,
        m.library,
      );
    })()
      .then(sendResponse)
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          code:
            error instanceof ConnectorError ? error.code : "connector-error",
          error:
            error instanceof ConnectorError
              ? error.message
              : "收录失败，请重新打开插件后重试",
        }),
      );
    return true;
  },
);
