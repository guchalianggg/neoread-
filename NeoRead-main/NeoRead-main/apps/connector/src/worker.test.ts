import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Candidate } from "./detect";
let listener: (
  message: unknown,
  sender: unknown,
  respond: (result: unknown) => void,
) => boolean;
let fetchMock: ReturnType<typeof vi.fn>;
let rules: ReturnType<typeof vi.fn>;
const candidate: Candidate = {
  title: "论文",
  sourceUrl: "https://kns.cnki.net/kcms2/article/abstract?v=example",
  pdfUrl: "https://kns.cnki.net/download?id=example",
  metadata: { title: "论文" },
  snapshot: "",
};
const dispatch = (message: unknown) =>
  new Promise<Record<string, unknown>>((resolve) =>
    listener(message, {}, (result) =>
      resolve(result as Record<string, unknown>),
    ),
  );
beforeEach(async () => {
  vi.resetModules();
  rules = vi.fn().mockResolvedValue(undefined);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "neoread-extension",
      getPlatformInfo: vi.fn().mockResolvedValue({}),
      onMessage: {
        addListener: (fn: typeof listener) => {
          listener = fn;
        },
      },
    },
    storage: {
      local: { get: vi.fn().mockResolvedValue({ secret: "test-secret" }) },
    },
    declarativeNetRequest: {
      updateSessionRules: rules,
      RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
      HeaderOperation: { SET: "set" },
      ResourceType: { XMLHTTPREQUEST: "xmlhttprequest" },
    },
  });
  await import("./worker");
});
afterEach(() => vi.unstubAllGlobals());
it("returns a verification error through the real save listener without importing HTML", async () => {
  fetchMock.mockResolvedValue(new Response("<title>安全验证</title>"));
  expect(await dispatch({ type: "save", candidate })).toMatchObject({
    ok: false,
    code: "cnki-verification",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(rules.mock.calls[0][0]).toEqual({ removeRuleIds: [17841] });
  expect(rules.mock.calls.at(-1)?.[0]).toEqual({ removeRuleIds: [17841] });
});
it("uploads only the validated PDF and preserves NeoRead labels and library choices", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response("%PDF-1.7\nbody"))
    .mockResolvedValueOnce(
      Response.json({ document: { id: "saved", title: "论文" } }),
    );
  expect(
    await dispatch({
      type: "save",
      candidate,
      folders: ["科研"],
      tags: ["安全"],
      library: "books",
      allowLarge: true,
    }),
  ).toMatchObject({ ok: true, document: { id: "saved" } });
  const [url, options] = fetchMock.mock.calls[1];
  expect(url).toBe("http://127.0.0.1:17841/v1/import");
  expect(options.headers).toEqual({ Authorization: "Bearer test-secret" });
  const form = options.body as FormData;
  expect(await (form.get("pdf") as Blob).text()).toBe("%PDF-1.7\nbody");
  expect(form.get("folders")).toBe('["科研"]');
  expect(form.get("tags")).toBe('["安全"]');
  expect(form.get("library")).toBe("books");
  expect(form.get("allowLarge")).toBe("1");
});
it("returns detail-page HTML through the authenticated CNKI message path", async () => {
  fetchMock.mockResolvedValue(new Response("<h1>详情页</h1>"));
  expect(
    await dispatch({
      type: "cnki-page",
      url: candidate.sourceUrl,
      sourceUrl: "https://kns.cnki.net/kns8s/defaultresult/",
    }),
  ).toMatchObject({ ok: true, html: "<h1>详情页</h1>" });
});
