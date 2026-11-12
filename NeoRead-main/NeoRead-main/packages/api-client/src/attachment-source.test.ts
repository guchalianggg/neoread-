import { afterEach, expect, it, vi } from "vitest";
import { api, configureAPI, paperAttachmentSource } from "./index";
afterEach(() => {
  configureAPI("");
  vi.unstubAllGlobals();
});
it("provides an encoded same-origin URL with current authentication for PDF ranges", () => {
  configureAPI("range-test-token");
  const source = paperAttachmentSource("paper/one", "supplement?two");
  expect(source).toEqual({
    url: "/api/documents/paper%2Fone/attachments/supplement%3Ftwo/file",
    httpHeaders: { Authorization: "Bearer range-test-token" },
  });
  expect(source.url).not.toContain("range-test-token");
  configureAPI("new-range-token");
  expect(
    paperAttachmentSource("paper", "attachment").httpHeaders.Authorization,
  ).toBe("Bearer new-range-token");
});
it("uses the same authenticated resource for explicit file downloads", async () => {
  configureAPI("range-test-token");
  const fetch = vi.fn(async () => new Response("file", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  expect(
    await (await api.downloadPaperAttachment("paper", "attachment")).text(),
  ).toBe("file");
  expect(fetch).toHaveBeenCalledWith(
    "/api/documents/paper/attachments/attachment/file",
    expect.objectContaining({
      headers: { Authorization: "Bearer range-test-token" },
    }),
  );
});
