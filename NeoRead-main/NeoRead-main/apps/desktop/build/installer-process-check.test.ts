import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "neoread-install-check-"));
  roots.push(root);
  const program = join(root, "NeoRead");
  const files = {
    "resources/web/assets/main-old-build.js": "retired web asset",
    "resources/agent.asar.unpacked/node_modules/retired/native.node": "retired runtime",
    "library/neoread.sqlite": "synthetic library; must survive",
    "personal/notes.txt": "synthetic user file; must survive",
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(program, name)), { recursive: true });
    await writeFile(join(program, name), content);
  }
  return { root, program, files };
}
async function checkFiles(program: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    expect(await readFile(join(program, name), "utf8")).toBe(content);
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("installer hooks only check running processes, without library scans or mandatory snapshots", async () => {
  const nsis = await readFile(join(here, "installer.nsh"), "utf8");
  expect(nsis).toContain("-Mode CheckStopped");
  expect(nsis).not.toMatch(/-Mode Install(?:\s|')/);
  for (const parameter of ["-UserData", "-BackupRoot", "-InstallRegistryKey", "-UninstallRegistryKey"]) {
    expect(nsis).not.toContain(parameter);
  }
  expect(nsis).toContain("-Mode Clean");
  expect(nsis).not.toMatch(/RMDir\s+\/r|Stop-Process|taskkill/i);
  expect(nsis).toContain("${isDeleteAppData}");
});

it.runIf(process.platform === "win32")("process-only CLI accepts old assets and unknown data without reading config or creating snapshots", async () => {
  const { root, program, files } = await fixture();
  await mkdir(join(root, "configuration"));
  await writeFile(join(root, "configuration/library-location.json"), "INVALID-OPAQUE-SYNTHETIC-CONFIG");
  const before = await readdir(root);
  const { stdout, stderr } = await execute("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(here, "upgrade-protection.ps1"),
    "-Mode", "CheckStopped", "-Destination", program,
    "-UserData", join(root, "configuration"), "-BackupRoot", join(root, "must-not-create-backups"),
    "-Manifest", join(root, "missing-manifest.json"),
  ], { timeout: 30_000, windowsHide: true });
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({ event: "process.check.complete" });
  expect(await readdir(root)).toEqual(before);
  expect(await readFile(join(root, "configuration/library-location.json"), "utf8")).toBe("INVALID-OPAQUE-SYNTHETIC-CONFIG");
  expect(stdout).not.toContain("SYNTHETIC");
  await checkFiles(program, files);
}, 40_000);

it.runIf(process.platform === "win32")("exact cleanup still preserves old assets, unknown files and an in-directory library", async () => {
  const { root, program, files } = await fixture();
  for (const name of ["NeoRead.exe", "resources/app.asar", "Uninstall NeoRead.exe"]) {
    await writeFile(join(program, name), "synthetic program file");
  }
  const manifest = join(root, "manifest.json");
  await writeFile(manifest, JSON.stringify({ schema: 1, files: ["NeoRead.exe", "resources\\app.asar"] }));
  const { stdout, stderr } = await execute("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(here, "upgrade-protection.ps1"),
    "-Mode", "Clean", "-Destination", program, "-Manifest", manifest, "-UninstallerName", "Uninstall NeoRead.exe",
  ], { timeout: 30_000, windowsHide: true });
  expect(stderr).toBe("");
  expect(JSON.parse(stdout).event).toBe("uninstall.protection.complete");
  for (const name of ["NeoRead.exe", "resources/app.asar", "Uninstall NeoRead.exe"]) {
    await expect(readFile(join(program, name))).rejects.toMatchObject({ code: "ENOENT" });
  }
  await checkFiles(program, files);
}, 40_000);
