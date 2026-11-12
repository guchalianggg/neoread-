import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commandLineStatus,
  isNeoReadLink,
  macInstall,
  macStatus,
  macUninstall,
  pathWith,
  pathWithout,
  neoreadBundleId,
  setCommandLine,
  windowsEnvironment,
} from "./command-line";

const app = "/Applications/NeoRead.app/Contents/Resources/bin/neoread";
let directory = "";
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});
async function link() {
  directory = await mkdtemp(join(tmpdir(), "neoread-cli-"));
  return join(directory, "bin", "neoread");
}
/** An app bundle on disk whose Info.plist names `id`; returns its command path. */
async function bundle(name: string, id?: string) {
  const contents = join(directory, name, "Contents");
  await mkdir(contents, { recursive: true });
  if (id)
    await writeFile(
      join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n    <key>CFBundleIdentifier</key>\n    <string>${id}</string>\n</dict></plist>\n`,
    );
  return join(directory, name, "Contents", "Resources", "bin", "neoread");
}

describe.skipIf(process.platform === "win32")("macOS link", () => {
  it("installs, recognises and removes its own link", async () => {
    const path = await link();
    expect(await macStatus(path, app)).toEqual({
      supported: true,
      installed: false,
      location: path,
    });
    expect((await macInstall(path, app)).installed).toBe(true);
    expect(await readlink(path)).toBe(app);
    expect((await macInstall(path, app)).installed).toBe(true);
    expect((await macUninstall(path, app)).installed).toBe(false);
  });
  it("replaces a link left by a moved NeoRead.app", async () => {
    const path = await link();
    await macInstall(
      path,
      "/Users/a/Downloads/NeoRead.app/Contents/Resources/bin/neoread",
    );
    const status = await macStatus(path, app);
    expect(status).toMatchObject({ installed: false });
    expect(status.conflict).toBeUndefined();
    await macInstall(path, app);
    expect(await readlink(path)).toBe(app);
  });
  it("leaves another program's reader alone", async () => {
    const path = await link();
    await macInstall(path, "/opt/other/reader");
    expect((await macStatus(path, app)).conflict).toBe(true);
    await expect(macInstall(path, app)).rejects.toThrow("已被其他程序占用");
    await expect(macUninstall(path, app)).rejects.toThrow("已被其他程序占用");
    expect(await readlink(path)).toBe("/opt/other/reader");

    await rm(path);
    await writeFile(path, "#!/bin/sh\n");
    expect((await macStatus(path, app)).conflict).toBe(true);
  });
  it("leaves another app's bundled reader alone", async () => {
    const path = await link();
    const other = await bundle("Other NeoRead.app", "com.example.reader");
    await macInstall(path, other);
    expect((await macStatus(path, app)).conflict).toBe(true);
    await expect(macInstall(path, app)).rejects.toThrow("已被其他程序占用");
    await expect(macUninstall(path, app)).rejects.toThrow("已被其他程序占用");
    expect(await readlink(path)).toBe(other);
  });
  it("recognises NeoRead links by bundle ID, or by name once deleted", async () => {
    await link();
    expect(
      await isNeoReadLink(await bundle("Renamed.app", neoreadBundleId)),
    ).toBe(true);
    expect(
      await isNeoReadLink(await bundle("NeoRead.app", "com.example")),
    ).toBe(false);
    expect(await isNeoReadLink(await bundle("NoPlist.app"))).toBe(false);
    expect(
      await isNeoReadLink(
        "/Volumes/gone/NeoRead 2.app/Contents/Resources/bin/neoread",
      ),
    ).toBe(true);
    expect(
      await isNeoReadLink(
        "/Volumes/gone/Other.app/Contents/Resources/bin/neoread",
      ),
    ).toBe(false);
    expect(await isNeoReadLink("/usr/local/Cellar/reader/1/bin/neoread")).toBe(
      false,
    );
  });
});

describe("Windows user PATH", () => {
  const bin = "C:\\Users\\a\\AppData\\Local\\Programs\\NeoRead\\resources\\bin";
  it("adds the directory once and keeps other entries verbatim", () => {
    const raw = "%USERPROFILE%\\.local\\bin;C:\\Tools;";
    const added = pathWith(raw, bin);
    expect(added).toBe(`%USERPROFILE%\\.local\\bin;C:\\Tools;${bin}`);
    expect(pathWith(added, bin.toUpperCase() + "\\")).toBe(added);
    expect(pathWith("", bin)).toBe(bin);
  });
  it("never lets an inherited variable turn a read into a write", () => {
    const env = {
      PATH: "C:\\Windows",
      NEOREAD_PATH_WRITE: "1",
      neoread_path_value: "",
      SystemRoot: "C:\\Windows",
    };
    expect(windowsEnvironment(env)).toEqual({
      PATH: "C:\\Windows",
      SystemRoot: "C:\\Windows",
    });
    expect(windowsEnvironment(env, "C:\\bin")).toEqual({
      PATH: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      NEOREAD_PATH_VALUE: "C:\\bin",
    });
  });
  it("removes every spelling of the directory", () => {
    expect(pathWithout(`C:\\Tools;"${bin}";${bin}\\;D:\\x`, bin)).toBe(
      "C:\\Tools;D:\\x",
    );
  });
});

describe("development builds", () => {
  it("do not install the worktree binary", async () => {
    const host = {
      platform: process.platform,
      packaged: false,
      binary: "/repo/apps/desktop/bin/neoread",
      env: {},
    };
    expect(await commandLineStatus(host)).toEqual({
      supported: false,
      installed: false,
      location: host.binary,
    });
    await expect(setCommandLine(host, true)).rejects.toThrow("开发版");
  });
  it("and unsupported platforms report no installer", async () => {
    const host = {
      platform: "linux" as const,
      packaged: true,
      binary: "/opt/NeoRead/resources/bin/neoread",
      env: {},
    };
    expect((await commandLineStatus(host)).supported).toBe(false);
  });
});
