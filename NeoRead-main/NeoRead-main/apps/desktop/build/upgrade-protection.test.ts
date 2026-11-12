import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const protection = require("./prepare-upgrade-protection.cjs") as {
  prepare: (options: { appOutDir: string; buildResourcesDir: string; templateDir: string; arch: string }) => Promise<{ schema: number; files: string[] }>;
  createProgramManifest: (directory: string) => Promise<{ files: string[] }>;
  validateRelativeFile: (file: string) => void;
  assertReviewedTemplates: (directory: string) => Promise<void>;
};
const execute = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const lib = require.resolve("app-builder-lib/package.json", { paths: [dirname(require.resolve("electron-builder"))] });
const templateDir = join(dirname(lib), "templates", "nsis");
const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "neoread-upgrade-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.runIf(process.platform === "win32" && !!process.env.PI_SCRATCH_DIR)("runs the actual PowerShell safety/snapshot/whitelist suite using synthetic fixtures", async () => {
  const root = await temporary();
  const { stdout, stderr } = await execute("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    join(here, "upgrade-protection.test.ps1"), "-Root", root,
  ], { timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  expect(stderr).toBe("");
  const result = JSON.parse(stdout.trim());
  expect(result.event).toBe("synthetic.upgrade.tests.passed");
  expect(result.assertions).toBeGreaterThanOrEqual(135);
  expect(stdout).not.toContain("FAKE-SYNTHETIC-API");
}, 130_000);

it.runIf(process.platform === "win32")("the real CLI returns 73 and sanitized status before simulated legacy uninstall on malformed config", async () => {
  const root = await temporary();
  const data = join(root, "data");
  await mkdir(data);
  await writeFile(join(data, "library-location.json"), "FAKE-OPAQUE-INVALID-CONFIG");
  const manifest = join(root, "program-files.json");
  await writeFile(manifest, JSON.stringify({ schema: 1, files: ["NeoRead.exe", "resources\\app.asar"] }));
  let legacyUninstalled = false;
  let failure: unknown;
  try {
    await execute("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(here, "upgrade-protection.ps1"),
      "-Mode", "Install", "-Destination", join(root, "new-program"), "-UserData", data,
      "-BackupRoot", join(root, "persistent-backups"), "-Manifest", manifest,
      "-InstallRegistryKey", `Software\\NeoReadSyntheticAbsent\\${Date.now()}`,
      "-UninstallRegistryKey", `Software\\NeoReadSyntheticAbsent\\${Date.now()}\\Uninstall`,
      "-UninstallerName", "Uninstall NeoRead.exe",
    ], { timeout: 60_000, windowsHide: true });
    legacyUninstalled = true;
  } catch (error) { failure = error; }
  expect(legacyUninstalled).toBe(false);
  const error = failure as { code: number; stdout: string; stderr: string };
  expect(error.code).toBe(73);
  expect(error.stderr).toBe("");
  expect(JSON.parse(error.stdout)).toMatchObject({ event: "upgrade.protection.blocked" });
  expect(error.stdout).not.toContain("FAKE-OPAQUE");
}, 70_000);

it("afterPack emits only exact program paths and pins the real upstream hook contract", async () => {
  const root = await temporary();
  const appOutDir = join(root, "app");
  const resources = join(appOutDir, "resources");
  await mkdir(resources, { recursive: true });
  await writeFile(join(appOutDir, "NeoRead.exe"), "synthetic executable");
  await writeFile(join(resources, "app.asar"), "synthetic app");
  await writeFile(join(resources, "中文资源.txt"), "synthetic resource");
  const manifest = await protection.prepare({ appOutDir, buildResourcesDir: root, templateDir, arch: "x64" });
  expect(manifest.files).toEqual(["NeoRead.exe", "resources\\app.asar", "resources\\中文资源.txt"]);
  expect(JSON.parse(await readFile(join(root, "program-files-x64.json"), "utf8"))).toEqual(manifest);
  // New user files added AFTER packaging are never silently added to the whitelist.
  await writeFile(join(resources, "personal.sqlite"), "user data");
  expect(manifest.files).not.toContain("resources\\personal.sqlite");
  const section = await readFile(join(templateDir, "installSection.nsh"), "utf8");
  expect(section.indexOf("!insertmacro CHECK_APP_RUNNING")).toBeLessThan(section.indexOf("!insertmacro uninstallOldVersion"));
  expect(section.indexOf("!insertmacro uninstallOldVersion")).toBeLessThan(section.indexOf("!insertmacro installApplicationFiles"));
  const custom = await readFile(join(here, "installer.nsh"), "utf8");
  expect(custom).toContain("!macro customCheckAppRunning");
  expect(custom).toContain("${UAC_IsInnerInstance}");
  expect(custom).toContain("!macro customRemoveFiles");
  expect(custom).not.toMatch(/(?:RMDir\s+\/r|KILL_PROCESS|Stop-Process|taskkill)/i);
  const copiedTemplates = join(root, "templates");
  await cp(templateDir, copiedTemplates, { recursive: true });
  await writeFile(join(copiedTemplates, "installSection.nsh"), "changed hook order");
  await expect(protection.assertReviewedTemplates(copiedTemplates)).rejects.toThrow("contract changed");
});

it.each(["..\\data", "resources\\..\\data", "C:\\data", "\\\\host\\share", "resources/*.pdf", "resources\\*.pdf", "$INSTDIR\\data", "resources\\file:stream", 'resources\\"quoted', "resources\\bad`name", "resources\\CON.txt", "resources\\name. "])("rejects unsafe manifest filenames: %s", (file) => {
  expect(() => protection.validateRelativeFile(file)).toThrow();
});

it("rejects symlink/junction package entries rather than listing their contents", async () => {
  const root = await temporary();
  const app = join(root, "app");
  const target = join(root, "outside");
  await mkdir(app);
  await mkdir(target);
  await symlink(target, join(app, "resources"), process.platform === "win32" ? "junction" : "dir");
  await expect(protection.createProgramManifest(app)).rejects.toThrow("Reparse/symlink");
});

it.runIf(process.platform === "win32" && !!process.env.PI_SCRATCH_DIR)("preserves a real crashed SQLite WAL library, category rows and opaque AI bytes", async () => {
  const root = await temporary();
  const library = join(root, "library");
  const data = join(root, "configuration");
  await mkdir(library);
  await mkdir(data);
  const database = join(library, "neoread.sqlite");
  // Simulate an exited/crashed producer without closing SQLite: committed data
  // stays in WAL/SHM, as it can after a real process exit. Never use a user DB.
  await execute(process.execPath, ["--no-warnings", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE documents(id TEXT, category TEXT); INSERT INTO documents VALUES ('latest-paper','SP');");
    process.exit(0);
  `, database]);
  const ai = Buffer.from('{"apiKey":"FAKE-TEST-ONLY","model":"synthetic"}\n');
  await writeFile(join(library, "ai-config.json"), ai);
  await writeFile(join(data, "library-location.json"), JSON.stringify({ directory: library }));
  await writeFile(join(root, "manifest.json"), JSON.stringify({ schema: 1, files: ["NeoRead.exe", "resources\\app.asar"] }));
  const wrapper = join(root, "snapshot-synthetic.ps1");
  await writeFile(wrapper, `param([string]$Protection, [string]$Fixture)
. $Protection
function Get-NeoReadProcesses { return @() }
$options = @{ Destination=(Join-Path $Fixture 'program'); UserData=(Join-Path $Fixture 'configuration'); BackupRoot=(Join-Path $Fixture 'backups'); Manifest=(Join-Path $Fixture 'manifest.json'); UninstallerName='Uninstall NeoRead.exe' }
Invoke-NeoReadUpgradeProtection @options | ConvertTo-Json -Compress
`);
  const { stdout, stderr } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper, "-Protection", join(here, "upgrade-protection.ps1"), "-Fixture", root], { timeout: 60_000, windowsHide: true });
  expect(stderr).toBe("");
  const result = JSON.parse(stdout.trim());
  expect(result.event).toBe("upgrade.protection.complete");
  const copied = join(root, "backups", result.snapshot, "library");
  for (const name of ["neoread.sqlite", "neoread.sqlite-wal", "neoread.sqlite-shm", "ai-config.json"]) {
    expect(await readFile(join(copied, name))).toEqual(await readFile(join(library, name)));
  }
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const recovered = new DatabaseSync(join(copied, "neoread.sqlite"), { readOnly: true });
  try {
    expect({ ...recovered.prepare("SELECT * FROM documents").get() }).toEqual({ id: "latest-paper", category: "SP" });
    expect(recovered.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  } finally { recovered.close(); }
  expect(stdout).not.toContain("FAKE-TEST-ONLY");
}, 70_000);
