import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cnkiPageError,
  downloadPDF,
  isCNKIURL,
  readCNKIPage,
} from "./download";
import type { Candidate } from "./detect";
const sourceUrl = "https://kns.cnki.net/kcms2/article/abstract?v=sample";
const candidate: Candidate = {
  title: "论文",
  sourceUrl,
  pdfUrl: "https://kns.cnki.net/download?id=sample",
  metadata: {},
  snapshot: "",
};
let rules: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  rules = vi.fn().mockResolvedValue(undefined);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "neoread-extension",
      getPlatformInfo: vi.fn().mockResolvedValue({}),
    },
    declarativeNetRequest: {
      updateSessionRules: rules,
      RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
      HeaderOperation: { SET: "set" },
      ResourceType: { XMLHTTPREQUEST: "xmlhttprequest" },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("downloads with browser credentials and a temporary origin-scoped Referer rule", async () => {
  fetchMock.mockResolvedValue(new Response("%PDF-1.7\nexample"));
  expect(await (await downloadPDF(candidate)).text()).toBe("%PDF-1.7\nexample");
  expect(fetchMock).toHaveBeenCalledWith(
    candidate.pdfUrl,
    expect.objectContaining({ credentials: "include", redirect: "follow" }),
  );
  expect(rules.mock.calls[0][0].addRules[0]).toMatchObject({
    action: {
      requestHeaders: [
        { header: "Referer", operation: "set", value: sourceUrl },
      ],
    },
    condition: {
      initiatorDomains: ["neoread-extension"],
      urlFilter: "|https://kns.cnki.net/",
      resourceTypes: ["xmlhttprequest"],
    },
  });
  expect(rules.mock.calls.at(-1)?.[0]).toEqual({ removeRuleIds: [17841] });
});
it("rejects HTTP 200 verification HTML instead of uploading it as a PDF", async () => {
  fetchMock.mockResolvedValue(
    new Response(
      '<html><title>安全验证</title><script src="/verify/js/app.js"></script></html>',
      { headers: { "content-type": "text/html" } },
    ),
  );
  await expect(downloadPDF(candidate)).rejects.toMatchObject({
    code: "cnki-verification",
  });
  expect(rules.mock.calls.at(-1)?.[0]).toEqual({ removeRuleIds: [17841] });
});
it.each([
  ["<title>用户登录</title>", "cnki-login"],
  ["<p>没有该文献的下载权限</p>", "cnki-access-denied"],
  ["<p>未说明原因的页面</p>", "pdf-invalid-response"],
])("classifies explicit non-PDF evidence: %s", async (html, code) => {
  fetchMock.mockResolvedValue(new Response(html));
  await expect(downloadPDF(candidate)).rejects.toMatchObject({ code });
});
it("does not infer a subscription failure from HTTP 403 alone", async () => {
  fetchMock.mockResolvedValue(new Response("Forbidden", { status: 403 }));
  await expect(downloadPDF(candidate)).rejects.toMatchObject({
    code: "pdf-http",
    message: "PDF 下载失败 (403)",
  });
});
it("ignores permission/login words in an article's abstract or ordinary login button", () => {
  expect(
    cnkiPageError(
      '<title>论文详情</title><div class="wx-tit">研究</div><p>没有下载权限的用户</p><button>登录</button>',
      sourceUrl,
    ),
  ).toBeUndefined();
});
it("distinguishes a CAJ-only page before making any download", async () => {
  await expect(
    downloadPDF({
      ...candidate,
      pdfUrl: "",
      cajUrl: "https://kns.cnki.net/caj",
    }),
  ).rejects.toMatchObject({ code: "cnki-caj-only" });
  expect(fetchMock).not.toHaveBeenCalled();
});
it("detects CAJ responses even when the selected button claimed PDF", async () => {
  fetchMock.mockResolvedValue(
    new Response("CAJ", {
      headers: { "content-disposition": 'attachment; filename="paper.caj"' },
    }),
  );
  await expect(downloadPDF(candidate)).rejects.toMatchObject({
    code: "cnki-caj-response",
  });
});
it("cleans up on a network failure and allows a subsequent request", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("network"));
  await expect(downloadPDF(candidate)).rejects.toMatchObject({
    code: "cnki-request-failed",
  });
  expect(rules.mock.calls.at(-1)?.[0]).toEqual({ removeRuleIds: [17841] });
  fetchMock.mockResolvedValueOnce(new Response("%PDF-1.7"));
  await expect(downloadPDF(candidate)).resolves.toBeInstanceOf(Blob);
});
it("serializes simultaneous downloads so article Referers cannot overwrite one another", async () => {
  let release!: (response: Response) => void;
  fetchMock
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(new Response("%PDF-2"));
  const first = downloadPDF(candidate);
  const second = downloadPDF({ ...candidate, sourceUrl: sourceUrl + "2" });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(rules.mock.calls.filter(([change]) => change.addRules)).toHaveLength(
    1,
  );
  release(new Response("%PDF-1"));
  await Promise.all([first, second]);
  const additions = rules.mock.calls.filter(([change]) => change.addRules);
  expect(additions[1][0].addRules[0].action.requestHeaders[0].value).toBe(
    sourceUrl + "2",
  );
});
it("aborts a stalled CNKI request and removes its rule", async () => {
  vi.useFakeTimers();
  fetchMock.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  const result = expect(downloadPDF(candidate)).rejects.toMatchObject({
    code: "cnki-timeout",
  });
  await vi.advanceTimersByTimeAsync(25_000);
  await result;
  expect(rules.mock.calls.at(-1)?.[0]).toEqual({ removeRuleIds: [17841] });
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects oversized downloads before buffering the response", async () => {
  fetchMock.mockResolvedValue(
    new Response("%PDF-", {
      headers: { "content-length": String(513 * 1024 * 1024) },
    }),
  );
  await expect(downloadPDF(candidate)).rejects.toMatchObject({
    code: "download-too-large",
  });
  expect(rules.mock.calls.at(-1)?.[0]).toEqual({ removeRuleIds: [17841] });
});
it("loads result-page details through the same authenticated request path", async () => {
  fetchMock.mockResolvedValue(
    new Response('<div class="wx-tit"><h1>论文</h1></div>'),
  );
  await expect(
    readCNKIPage(sourceUrl, "https://kns.cnki.net/kns8s/defaultresult/"),
  ).resolves.toMatchObject({ url: sourceUrl });
  expect(
    rules.mock.calls[0][0].addRules[0].action.requestHeaders[0].value,
  ).toBe("https://kns.cnki.net/kns8s/defaultresult/");
});
it("does not install CNKI rules for ordinary publishers or external attachment hosts", async () => {
  fetchMock.mockResolvedValue(new Response("%PDF-1.7"));
  await downloadPDF({
    ...candidate,
    sourceUrl: "https://example.org/article",
    pdfUrl: "https://example.org/file.pdf",
  });
  expect(rules).not.toHaveBeenCalled();
});
it("rejects lookalikes, credentials and protocol downgrades", async () => {
  for (const url of [
    "https://cnki.net.example.org/",
    "https://evilcnki.net/",
    "https://cnki.net@evil.org/",
    "javascript:alert(1)",
    "https://user:password@kns.cnki.net/",
  ])
    expect(isCNKIURL(url)).toBe(false);
  await expect(
    readCNKIPage("https://cnki.net.example.org/", sourceUrl),
  ).rejects.toMatchObject({ code: "cnki-invalid-url" });
  await expect(
    downloadPDF({ ...candidate, pdfUrl: "http://kns.cnki.net/download" }),
  ).rejects.toMatchObject({ code: "cnki-insecure-download" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(["验证码识别研究", "单点登录研究", "安全验证机制分析"])(
  "does not mistake a paper titled %s for an access challenge",
  (title) => {
    expect(
      cnkiPageError(
        `<title>${title} - 中国知网</title><div class="wx-tit"><h1>${title}</h1></div>`,
        sourceUrl,
      ),
    ).toBeUndefined();
  },
);
