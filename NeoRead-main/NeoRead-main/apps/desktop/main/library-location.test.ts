import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(() => {}, { [promisify.custom]: execute }) };
});
import {
  libraryDirectory,
  migrateLibrary,
  stopLibraryServer,
  validateLibraryDirectory,
  validateLibraryDestination,
  saveLibraryDirectory,
} from "./library-location";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "neoread-location-"));
  execute.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});
it("uses the old location only when no configuration exists", async () => {
  expect(await libraryDirectory(directory)).toBe(join(directory, "library"));
  const moved = join(directory, "moved");
  await mkdir(moved);
  await writeFile(join(moved, "neoread.sqlite"), "db");
  await writeFile(
    join(directory, "library-location.json"),
    JSON.stringify({ directory: moved }),
  );
  expect(await libraryDirectory(directory)).toBe(moved);
  await rm(moved, { recursive: true });
  await expect(libraryDirectory(directory)).rejects.toThrow("书库");
});
it.each(["not json", "{}", '{"directory":"relative"}'])(
  "rejects invalid saved locations rather than creating a blank library",
  async (text) => {
    await writeFile(join(directory, "library-location.json"), text);
    await expect(libraryDirectory(directory)).rejects.toThrow();
  },
);
it("waits for shutdown and copies before switching the saved path", async () => {
  const order: string[] = [];
  const target = join(directory, "new");
  execute.mockImplementation(async () => {
    order.push("copy");
    expect(await libraryDirectory(directory)).toBe(join(directory, "library"));
    await mkdir(target);
    await writeFile(join(target, "neoread.sqlite"), "db");
  });
  await migrateLibrary(
    directory,
    join(directory, "library"),
    target,
    "/neoread-server",
    async () => {
      order.push("stop");
    },
  );
  expect(order).toEqual(["stop", "copy"]);
  expect(execute).toHaveBeenCalledWith(
    "/neoread-server",
    ["--data", join(directory, "library"), "--migrate-library", target],
    expect.objectContaining({ windowsHide: true }),
  );
  expect(await libraryDirectory(directory)).toBe(target);
});
it("keeps the saved location on copy failure and never copies after shutdown failure", async () => {
  const original = JSON.stringify({ directory: join(directory, "original") });
  await writeFile(join(directory, "library-location.json"), original);
  execute.mockRejectedValueOnce(new Error("disk full"));
  await expect(
    migrateLibrary(directory, "source", join(directory, "target"), "binary", async () => {}),
  ).rejects.toThrow("disk full");
  expect(await readFile(join(directory, "library-location.json"), "utf8")).toBe(
    original,
  );
  execute.mockClear();
  await expect(
    migrateLibrary(directory, "source", join(directory, "target"), "binary", async () => {
      throw new Error("still running");
    }),
  ).rejects.toThrow("still running");
  expect(execute).not.toHaveBeenCalled();
});
it("uses stdin EOF and waits for the server to finish closing", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
  });
  let stopped = false;
  const promise = stopLibraryServer(child as unknown as ChildProcess).then(
    () => {
      stopped = true;
    },
  );
  expect(child.stdin.end).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(stopped).toBe(false);
  child.emit("close", 0, null);
  await promise;
  expect(stopped).toBe(true);
});
it("refuses to migrate if the server fails to shut down cleanly", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
  });
  const promise = stopLibraryServer(child as unknown as ChildProcess);
  const assertion = expect(promise).rejects.toThrow("停止");
  await vi.advanceTimersByTimeAsync(30000);
  await assertion;
  expect(child.listenerCount("close")).toBe(0);
});

it("blocks installation descendants/ancestors before stopping, checking, copying or saving", async () => {
  const program = join(directory, "NeoRead");
  const originalLibrary = join(program, "已有书库");
  await mkdir(originalLibrary, { recursive: true });
  await writeFile(join(originalLibrary, "neoread.sqlite"), "db with categories");
  const original = JSON.stringify({ directory: originalLibrary });
  await writeFile(join(directory, "library-location.json"), original);
  // A previously unsafe location remains usable so the migration UI can repair it.
  expect(await libraryDirectory(directory)).toBe(originalLibrary);
  for (const target of [program, join(program, "新书库"), directory, program.toUpperCase()]) {
    if (process.platform !== "win32" && target === program.toUpperCase()) continue;
    const stopped = vi.fn();
    await expect(migrateLibrary(directory, originalLibrary, target, "binary", stopped, program)).rejects.toThrow("外部目录");
    await expect(validateLibraryDirectory(target, "binary", program)).rejects.toThrow("外部目录");
    await expect(saveLibraryDirectory(directory, target, program)).rejects.toThrow("外部目录");
    expect(stopped).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(join(directory, "library-location.json"), "utf8")).toBe(original);
  }
});

it("allows prefix-similar external directories, development libraries and outward migration", async () => {
  const program = join(directory, "NeoRead");
  const external = join(directory, "NeoRead Library 中文");
  await mkdir(program);
  await mkdir(external);
  await validateLibraryDestination(external, program);
  await validateLibraryDestination(join(program, "dev-fixture"));
  execute.mockResolvedValueOnce({});
  await migrateLibrary(directory, join(program, "old-library"), external, "binary", async () => {}, program);
  // This test targets path safety, not the existing database validator.
  expect(JSON.parse(await readFile(join(directory, "library-location.json"), "utf8")).directory).toBe(external);
});

it("resolves existing junction ancestors before accepting a future library directory", async () => {
  const program = join(directory, "NeoRead");
  const alias = join(directory, "alias");
  await mkdir(program);
  await symlink(program, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(validateLibraryDestination(join(alias, "future-library"), program)).rejects.toThrow("外部目录");
});
