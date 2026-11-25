import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { acceptsDocumentFile } from "../../../packages/neoread-core/src/import-formats";

export type OriginalDisposition = "keep" | "trash";
type Library = "books" | "papers";
export type LocalImportResult = {
  documents: string[];
  large: { id: string; name: string; pages: number }[];
  failed: number;
  kept: number;
  linkFailed: number;
  error?: string;
};
export type SourceSyncResult = {
  state:
    | "unlinked"
    | "current"
    | "updated"
    | "missing"
    | "conflict"
    | "busy"
    | "failed";
  revision?: number;
};
type Host = {
  profile: string;
  library: string;
  request: (path: string, body: BodyInit) => Promise<Response>;
  trash: (path: string) => Promise<void>;
  record?: (
    event:
      | "document.import_original"
      | "document.source_sync_check"
      | "document.markdown_watch",
    reason: string,
  ) => void;
};
type Pick = {
  path: string;
  disposition: OriginalDisposition;
  confirmedStamp?: string;
  expires?: number;
};
const sourceFile = /\.(md|markdown|doc|docx)$/i;
const markdownFile = /\.(md|markdown)$/i;
const markdownWatchDelay = 250;
const documentID = /^[a-f0-9]{32}$/;
const hash = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const importLimit = 512 * 1024 * 1024;
const syncLimit = 64 * 1024 * 1024;
const errorCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const emptyResult = (): LocalImportResult => ({
  documents: [],
  large: [],
  failed: 0,
  kept: 0,
  linkFailed: 0,
});

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

type Info = Awaited<ReturnType<typeof fileInfo>>;
async function fileInfo(path: string) {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile()) throw new Error("请选择普通文件，不支持符号链接。");
  return info;
}
const stamp = (info: Info) =>
  [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
// On Windows the path stat can omit the volume serial that fstat returns.
const sameFile = (a: Info, b: Info) =>
  (!a.dev || !b.dev || a.dev === b.dev) && stamp(a) === stamp(b);

async function readStable(path: string, limit: number, before: Info) {
  if (before.size > BigInt(limit)) throw new Error("文件超过大小上限。");
  const file = await open(path, "r");
  try {
    if (!sameFile(before, await file.stat({ bigint: true })))
      throw new Error("文件在读取时发生变化，请稍后重试。");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        read,
        bytes.length - read,
        read,
      );
      if (!bytesRead) break;
      read += bytesRead;
    }
    if (
      read !== Number(before.size) ||
      !sameFile(before, await file.stat({ bigint: true })) ||
      !sameFile(before, await fileInfo(path))
    )
      throw new Error("文件在读取时发生变化，请稍后重试。");
    return bytes.subarray(0, read);
  } finally {
    await file.close();
  }
}

async function unchangedContent(path: string, before: Info, digest: string) {
  const file = await open(path, "r");
  try {
    if (!sameFile(before, await file.stat({ bigint: true }))) return false;
    const check = createHash("sha256");
    const chunk = Buffer.alloc(128 * 1024);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > Number(before.size)) return false;
      check.update(chunk.subarray(0, bytesRead));
    }
    return (
      offset === Number(before.size) &&
      check.digest("hex") === digest &&
      sameFile(before, await file.stat({ bigint: true })) &&
      sameFile(before, await fileInfo(path))
    );
  } finally {
    await file.close();
  }
}

export function createLocalDocumentImport(host: Host) {
  // Absolute paths are private, local to this profile and library. They are
  // never passed through the renderer or sent to the document converter.
  const links = join(host.profile, "source-links", hash(host.library));
  const linkPath = (id: string) => join(links, `${id}.json`);
  const tickets = new Map<string, Pick>();
  const uploaded = new Map<string, { stamp: string; revision?: number }>();
  const inFlight = new Map<string, Promise<SourceSyncResult>>();
  const syncFailures = new Map<string, string>();
  const record = (
    event: Parameters<NonNullable<Host["record"]>>[0],
    reason: string,
  ) => {
    try {
      host.record?.(event, reason);
    } catch {
      /* Diagnostics never affect import. */
    }
  };
  async function external(path: string) {
    if (!isAbsolute(path) || relative(path, await realpath(path))) return false;
    const roots = await Promise.all(
      [host.profile, host.library].map((root) => realpath(root)),
    );
    return !roots.some((root) => inside(root, path));
  }
  async function importPicks(
    picks: Pick[],
    library: Library,
    folder: string,
    allowLarge: boolean,
  ) {
    const result = emptyResult();
    for (const pick of picks) {
      const { path, disposition } = pick;
      if (!isAbsolute(path) || !acceptsDocumentFile(path, library)) continue;
      try {
        const before = await fileInfo(path);
        const data = await readStable(path, importLimit, before);
        const digest = hash(data);
        const name = basename(path);
        const form = new FormData();
        form.append("library", library);
        if (allowLarge) form.append("allowLarge", "1");
        if (folder.startsWith("smart:"))
          form.append("smartCategory", folder.slice(6));
        else if (folder) form.append("folder", folder.replace(/^folder:/, ""));
        form.append("file", new Blob([data]), name);
        const response = await host.request("/api/documents", form);
        const value = await response.json();
        if (
          !allowLarge &&
          response.status === 409 &&
          value?.code === "large-paper"
        ) {
          const id = randomUUID();
          tickets.set(id, {
            path,
            disposition,
            confirmedStamp: stamp(before),
            expires: Date.now() + 15 * 60_000,
          });
          result.large.push({
            id,
            name,
            pages: typeof value.pages === "number" ? value.pages : 0,
          });
          continue;
        }
        if (!response.ok || value?.id !== digest.slice(0, 32)) {
          if (!result.error && !response.ok && typeof value?.error === "string")
            result.error = value.error;
          throw new Error("导入未确认");
        }
        const id: string = value.id;
        result.documents.push(id);
        if (disposition === "trash") {
          try {
            // A deduplicated file may already be linked elsewhere. Keep it.
            if (
              response.status !== 201 ||
              (pick.confirmedStamp !== undefined &&
                pick.confirmedStamp !== stamp(before)) ||
              !(await external(path)) ||
              stamp(await fileInfo(path)) !== stamp(before)
            ) {
              result.kept++;
              record("document.import_original", "retained");
              continue;
            }
            if (!(await unchangedContent(path, before, digest))) {
              result.kept++;
              record("document.import_original", "retained");
              continue;
            }
            await host.trash(path);
            record("document.import_original", "recycled");
          } catch {
            result.kept++;
            record("document.import_original", "recycle_failed");
          }
        } else if (sourceFile.test(name)) {
          try {
            if (!(await external(path))) continue;
            await mkdir(links, { recursive: true, mode: 0o700 });
            // Never silently change an existing document's bound location.
            await writeFile(linkPath(id), JSON.stringify({ path }), {
              flag: "wx",
              mode: 0o600,
            });
            uploaded.set(id, { stamp: stamp(before) });
          } catch (error) {
            if (errorCode(error) !== "EEXIST") {
              result.linkFailed++;
              record("document.import_original", "link_failed");
            }
          }
        }
      } catch (error) {
        result.failed++;
        result.error ??= errorCode(error) ? "无法读取文件。" : "未能导入文件。";
      }
    }
    return result;
  }

  async function linkedPath(id: string) {
    const value = JSON.parse(await readFile(linkPath(id), "utf8"));
    if (
      typeof value?.path !== "string" ||
      !isAbsolute(value.path) ||
      !sourceFile.test(value.path)
    )
      throw new Error("Invalid source link");
    return value.path as string;
  }

  const watchFailures = new Set<string>();
  async function watchMarkdown(
    id: string,
    signal: AbortSignal,
    changed: () => void,
  ) {
    if (!documentID.test(id) || signal.aborted) return;
    const failed = () => {
      if (signal.aborted || watchFailures.has(id)) return;
      watchFailures.add(id);
      record("document.markdown_watch", "polling_fallback");
    };
    try {
      const path = await linkedPath(id);
      const directory = dirname(path);
      if (
        !markdownFile.test(path) ||
        !(await external(directory)) ||
        signal.aborted
      )
        return;
      const compare = (name: string) =>
        process.platform === "win32" ? name.toLowerCase() : name;
      const name = compare(basename(path));
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Watch the directory, not the inode: editors often save via rename.
      const watcher = watch(
        directory,
        { persistent: false, signal },
        (_, filename) => {
          if (signal.aborted || (filename && compare(filename) !== name))
            return;
          watchFailures.delete(id);
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (!signal.aborted) changed();
          }, markdownWatchDelay);
        },
      );
      watcher.once("close", () => clearTimeout(timer));
      watcher.once("error", () => {
        failed();
        watcher.close();
      });
    } catch (error) {
      // Missing link = ordinary imported copy, no watcher expected.
      if (errorCode(error) !== "ENOENT") failed();
    }
  }

  async function check(id: string): Promise<SourceSyncResult> {
    const fail = (
      state: "missing" | "conflict" | "busy" | "failed",
    ): SourceSyncResult => {
      if (syncFailures.get(id) !== state)
        record("document.source_sync_check", state);
      syncFailures.set(id, state);
      return { state };
    };
    let path: string;
    try {
      path = await linkedPath(id);
    } catch (error) {
      return errorCode(error) === "ENOENT"
        ? { state: "unlinked" }
        : fail("failed");
    }
    try {
      if (!(await external(path))) return fail("missing");
      const before = await fileInfo(path);
      const cached = uploaded.get(id);
      if (cached?.stamp === stamp(before)) {
        syncFailures.delete(id);
        return {
          state: "current",
          ...(cached.revision ? { revision: cached.revision } : {}),
        };
      }
      const data = await readStable(path, syncLimit, before);
      const response = await host.request(
        `/api/documents/${id}/source-sync`,
        data,
      );
      if (response.status === 204) {
        syncFailures.delete(id);
        uploaded.set(id, { stamp: stamp(before), revision: cached?.revision });
        return {
          state: "current",
          ...(cached?.revision ? { revision: cached.revision } : {}),
        };
      }
      if (response.status === 404) return { state: "unlinked" };
      const value = await response.json();
      if (response.status === 409)
        return fail(value?.code === "busy" ? "busy" : "conflict");
      if (
        response.status !== 200 ||
        !Number.isSafeInteger(value?.revision) ||
        value.revision < 1
      )
        return fail("failed");
      uploaded.set(id, { stamp: stamp(before), revision: value.revision });
      syncFailures.delete(id);
      return { state: "updated", revision: value.revision };
    } catch (error) {
      return fail(errorCode(error) === "ENOENT" ? "missing" : "failed");
    }
  }

  return {
    import(
      paths: string[],
      library: Library,
      folder: string,
      disposition: OriginalDisposition,
    ) {
      for (const [id, pick] of tickets)
        if (pick.expires! < Date.now()) tickets.delete(id);
      return importPicks(
        [...new Set(paths)].map((path) => ({ path, disposition })),
        library,
        folder,
        false,
      );
    },
    confirm(ids: unknown[], library: Library, folder: string) {
      const picks: Pick[] = [];
      for (const id of ids) {
        if (typeof id !== "string") continue;
        const pick = tickets.get(id);
        tickets.delete(id);
        if (pick?.expires && pick.expires >= Date.now()) picks.push(pick);
      }
      return importPicks(picks, library, folder, true);
    },
    watchMarkdown,
    sync(id: string): Promise<SourceSyncResult> {
      if (!documentID.test(id)) return Promise.resolve({ state: "unlinked" });
      const existing = inFlight.get(id);
      if (existing) return existing;
      const job = check(id).finally(() => inFlight.delete(id));
      inFlight.set(id, job);
      return job;
    },
  };
}
