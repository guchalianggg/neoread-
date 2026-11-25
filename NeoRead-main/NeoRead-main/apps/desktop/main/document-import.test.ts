import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalDocumentImport } from "./document-import";

const roots: string[] = [];
const id = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex").slice(0, 32);
async function fixture(bytes = "# Original") {
  const root = await mkdtemp(join(tmpdir(), "neoread-import-test-"));
  roots.push(root);
  const profile = join(root, "profile");
  const library = join(root, "library");
  await mkdir(profile);
  await mkdir(library);
  const path = join(root, "original.md");
  await writeFile(path, bytes);
  const request = vi.fn(async (_path: string, _body: BodyInit) =>
    Response.json({ id: id(bytes) }, { status: 201 }),
  );
  const trash = vi.fn(async (_path: string) => {});
  const record = vi.fn();
  const host = { profile, library, request, trash, record };
  return {
    ...host,
    path,
    importer: createLocalDocumentImport(host),
    document: id(bytes),
  };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("only recycles after a new import has succeeded", async () => {
  const { importer, request, trash, path, document } = await fixture();
  request.mockResolvedValueOnce(
    Response.json({ error: "无效文件" }, { status: 400 }),
  );
  expect((await importer.import([path], "papers", "", "trash")).failed).toBe(1);
  expect(trash).not.toHaveBeenCalled();
  request.mockResolvedValueOnce(
    Response.json({ id: document }, { status: 200 }),
  );
  expect((await importer.import([path], "papers", "", "trash")).kept).toBe(1);
  expect(trash).not.toHaveBeenCalled();
  expect(
    (await importer.import([path], "papers", "", "trash")).documents,
  ).toEqual([document]);
  expect(trash).toHaveBeenCalledOnce();
  expect(await importer.sync(document)).toEqual({ state: "unlinked" });
});

it("preserves originals changed while importing and reports recycle failures", async () => {
  const { importer, request, trash, path, document } = await fixture();
  request.mockImplementationOnce(async () => {
    await writeFile(path, "# External save during upload");
    return Response.json({ id: document }, { status: 201 });
  });
  expect((await importer.import([path], "papers", "", "trash")).kept).toBe(1);
  expect(trash).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe("# External save during upload");
  request.mockResolvedValueOnce(
    Response.json({ id: id("# External save during upload") }, { status: 201 }),
  );
  trash.mockRejectedValueOnce(new Error("not available"));
  expect((await importer.import([path], "papers", "", "trash")).kept).toBe(1);
  expect(await readFile(path, "utf8")).toBe("# External save during upload");
});

it("links a kept Markdown path to one ID after restart without writing to it", async () => {
  const host = await fixture();
  const { importer, request, trash, path, document } = host;
  expect(
    (await importer.import([path], "papers", "", "keep")).documents,
  ).toEqual([document]);
  expect(trash).not.toHaveBeenCalled();
  await writeFile(path, "# Updated from disk");
  const reopened = createLocalDocumentImport(host);
  request.mockResolvedValueOnce(Response.json({ revision: 2 }));
  expect(await reopened.sync(document)).toEqual({
    state: "updated",
    revision: 2,
  });
  const [route, bytes] = request.mock.calls.at(-1)!;
  expect(route).toBe(`/api/documents/${document}/source-sync`);
  expect(Buffer.from(bytes as Uint8Array).toString()).toBe(
    "# Updated from disk",
  );
  expect(await reopened.sync(document)).toEqual({
    state: "current",
    revision: 2,
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(await readFile(path, "utf8")).toBe("# Updated from disk");
  await rm(path);
  expect(await reopened.sync(document)).toEqual({ state: "missing" });
});

it("carries the chosen disposition through long paper confirmation", async () => {
  const { importer, request, trash, path } = await fixture();
  const pdf = path.replace(/\.md$/, ".pdf");
  const bytes = "%PDF- fake stub";
  await writeFile(pdf, bytes);
  request.mockResolvedValueOnce(
    Response.json({ code: "large-paper", pages: 90 }, { status: 409 }),
  );
  const first = await importer.import([pdf], "papers", "", "trash");
  expect(trash).not.toHaveBeenCalled();
  const ticket = first.large[0];
  request.mockResolvedValueOnce(
    Response.json({ id: id(bytes) }, { status: 201 }),
  );
  expect((await importer.confirm([ticket.id], "books", "")).documents).toEqual([
    id(bytes),
  ]);
  expect(trash).toHaveBeenCalledOnce();
  expect((await importer.confirm([ticket.id], "books", "")).documents).toEqual(
    [],
  );
});
