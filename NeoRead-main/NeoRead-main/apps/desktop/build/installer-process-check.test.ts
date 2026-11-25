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
  for (const parameter of ["-UserData", "-BackupRoot"]) {
    expect(nsis).not.toContain(parameter);
  }
  expect(nsis).toContain('-InstallRegistryKey "${INSTALL_REGISTRY_KEY}" -UninstallRegistryKey "${UNINSTALL_REGISTRY_KEY}"');
  expect(nsis).toContain('-UninstallRegistryKey2 "${UNINSTALL_REGISTRY_KEY_2}"');
  expect(nsis).toContain("-Mode Clean");
  expect(nsis).not.toMatch(/RMDir\s+\/r|Stop-Process|taskkill/i);
  expect(nsis).toContain("${isDeleteAppData}");
});

it("keeps the registered GUI path and only repairs the builder's managed shortcuts", async () => {
  const nsis = await readFile(join(here, "installer.nsh"), "utf8");
  expect(nsis).toContain("!define MUI_PAGE_CUSTOMFUNCTION_PRE neoreadInstFilesPre");
  expect(nsis).toMatch(/ReadRegStr \$0 SHELL_CONTEXT "\$\{INSTALL_REGISTRY_KEY\}" "InstallLocation"\s+\$\{If\} \$INSTDIR != \$0\s+Call instFilesPre/);
  expect(nsis).not.toMatch(/MessageBox[^\r\n]*NeoRead/);
  expect(nsis).toContain('"NeoRead.pdf"');
  expect(nsis).toContain('"NeoRead.epub"');
  expect(nsis).toMatch(/\$\{ElseIfNot\} \$\{FileExists\} "\$\{OLD_LINK\}"\s+StrCpy \$\{STATE\} "absent"/);
  const finishLink = nsis.split("!macro neoreadFinishManagedLink")[1].split("!macroend")[0];
  expect(finishLink).toMatch(/\$\{If\} \$\{FileExists\} "\$\{LINK\}"\s+\$\{If\} \$\{STATE\} == "absent"\s+Delete "\$\{LINK\}"/);
  expect(finishLink).toContain('${AndIf} ${STATE} != "collision"');
  expect(finishLink).toContain('CreateShortCut "${LINK}" "$appExe" "" "$appExe" 0');
  expect(finishLink).toContain('WinShell::SetLnkAUMI "${LINK}" "${APP_ID}"');
  const install = nsis.split(/^!macro customInstall\s*$/m)[1].split("!macroend")[0];
  expect(install).toMatch(/!ifndef DO_NOT_CREATE_START_MENU_SHORTCUT\s+!insertmacro neoreadFinishManagedLink \$newStartMenuLink/);
  expect(install).toMatch(/!ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT\s+\$\{IfNot\} \$\{isNoDesktopShortcut\}\s+!insertmacro neoreadFinishManagedLink \$newDesktopLink/);
  expect(install).toMatch(/\$\{If\} \$neoreadStartMenuBefore == "absent"\s+StrCpy \$launchLink "\$appExe"/);
});

it.runIf(process.platform === "win32")("blocks Reader by destination or registered path, not by its global name", async () => {
  const { root, program } = await fixture();
  const script = join(root, "process-test.ps1");
  await writeFile(script, String.raw`param([string]$Protection, [string]$FixturePath)
. $Protection
function Get-NeoReadProcesses { $script:fakeProcess }
function Get-RegisteredInstallDirs([string]$InstallKey, [string[]]$UninstallKeys) {
    if ($InstallKey -ne 'test-install' -or $UninstallKeys.Count -ne 2) { throw 'wrong test keys' }
    return "$FixturePath-registered"
}
function Assert-Blocked {
    try {
        Assert-NeoReadInstallStopped $FixturePath 'test-install' @('test-uninstall', 'test-legacy')
    } catch [InvalidOperationException] {
        if ($_.Exception.Message -eq 'app_running') { return }
        throw
    }
    throw 'expected app_running'
}
$script:fakeProcess = [pscustomobject]@{ Name = 'Reader.exe'; ExecutablePath = "$FixturePath\Reader.exe" }
Assert-Blocked
$script:fakeProcess.ExecutablePath = "$FixturePath-registered\Reader.exe"
Assert-Blocked
$script:fakeProcess.ExecutablePath = "$FixturePath-registered-other\Reader.exe"
Assert-NeoReadInstallStopped $FixturePath 'test-install' @('test-uninstall', 'test-legacy')
$script:fakeProcess.ExecutablePath = $null
Assert-NeoReadInstallStopped $FixturePath 'test-install' @('test-uninstall', 'test-legacy')
$script:fakeProcess.Name = 'NeoRead.exe'
Assert-Blocked
$script:fakeProcess.Name = 'neoread-server.exe'
Assert-Blocked
Write-Output 'synthetic process cases passed'
`);
  const { stdout, stderr } = await execute("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-Protection", join(here, "upgrade-protection.ps1"), "-FixturePath", program,
  ], { timeout: 30_000, windowsHide: true });
  expect(stderr).toBe("");
  expect(stdout.trim()).toBe("synthetic process cases passed");
}, 40_000);

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
  await writeFile(join(program, "NeoRead.exe"), "legacy executable absent from Reader's exact manifest");
  for (const name of ["Reader.exe", "resources/app.asar", "Uninstall Reader.exe"]) {
    await writeFile(join(program, name), "synthetic program file");
  }
  const manifest = join(root, "manifest.json");
  await writeFile(manifest, JSON.stringify({ schema: 1, files: ["Reader.exe", "resources\\app.asar"] }));
  const { stdout, stderr } = await execute("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(here, "upgrade-protection.ps1"),
    "-Mode", "Clean", "-Destination", program, "-Manifest", manifest, "-UninstallerName", "Uninstall Reader.exe",
  ], { timeout: 30_000, windowsHide: true });
  expect(stderr).toBe("");
  expect(JSON.parse(stdout).event).toBe("uninstall.protection.complete");
  for (const name of ["Reader.exe", "resources/app.asar", "Uninstall Reader.exe"]) {
    await expect(readFile(join(program, name))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await readFile(join(program, "NeoRead.exe"), "utf8")).toBe("legacy executable absent from Reader's exact manifest");
  await checkFiles(program, files);
}, 40_000);
