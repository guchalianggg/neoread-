import { afterEach, expect, it, vi } from "vitest";
import { api, configureAPI, RequestError } from "./index";
import type { SourceEditSnapshot } from "@neoread/core";
const snapshot: SourceEditSnapshot = {
  kind: "md",
  filename: "notes.md",
  revision: 1,
  editable: true,
  content: "# Notes",
};
afterEach(() => vi.unstubAllGlobals());
it("authenticates an encoded source-editor read and passes cancellation", async () => {
  configureAPI("source-edit-test");
  const fetch = vi.fn(async () => new Response(JSON.stringify(snapshot)));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  expect(await api.getSourceEdit("notes/id", signal)).toEqual(snapshot);
  expect(fetch).toHaveBeenCalledWith(
    "/api/documents/notes%2Fid/source-edit",
    expect.objectContaining({
      signal,
      headers: expect.objectContaining({
        Authorization: "Bearer source-edit-test",
      }),
    }),
  );
});
it("saves content with its optimistic revision", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ ...snapshot, revision: 2, content: "updated" }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  await api.saveSourceEdit("notes", { revision: 1, content: "updated" });
  expect(fetch).toHaveBeenCalledWith(
    "/api/documents/notes/source-edit",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ revision: 1, content: "updated" }),
    }),
  );
});
it("exposes revision conflicts instead of treating them as a successful save", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "版本冲突" }), { status: 409 }),
    ),
  );
  await expect(
    api.saveSourceEdit("notes", { revision: 1, content: "draft" }),
  ).rejects.toMatchObject({ message: "版本冲突", status: 409 });
});
it("authenticates edited-file downloads and returns the complete blob", async () => {
  configureAPI("source-edit-test");
  const fetch = vi.fn(async () => new Response("complete document"));
  vi.stubGlobal("fetch", fetch);
  const blob = await api.downloadSourceEdit("notes/id");
  expect(await blob.text()).toBe("complete document");
  expect(fetch).toHaveBeenCalledWith(
    "/api/documents/notes%2Fid/source-edit/file",
    expect.objectContaining({
      headers: { Authorization: "Bearer source-edit-test" },
    }),
  );
});
it("does not return an error response as a downloadable document", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "不存在" }), { status: 404 }),
    ),
  );
  await expect(api.downloadSourceEdit("gone")).rejects.toBeInstanceOf(
    RequestError,
  );
});
