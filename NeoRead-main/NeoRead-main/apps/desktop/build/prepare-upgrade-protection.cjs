const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Hook ordering is part of the data-safety contract. Updating electron-builder
// requires reviewing these templates again; never silently accept a new order.
const reviewedTemplates = {
  "installer.nsi": "8811964416d122612c3e7601728af5d3f998d677918df829a4e8b4c739c8b9f8",
  "installSection.nsh": "74c4dbb4163cdd90ca4850b75d304e916235c882d6af7b5cdad63bffbc977072",
  "uninstaller.nsh": "9ee2dac4593478083e8aa6f8487287ce9401006ccd50ecc538871d133ea4a42c",
  "include/allowOnlyOneInstallerInstance.nsh": "23af250b7a6d29890b1b51432f8c718d5c2e1bdfce412cfaf97f5c1a72f7f74b",
};

function validateRelativeFile(file) {
  if (!file || path.win32.isAbsolute(file) || /[\x00-\x1f<>:"|?*$`!\/]/u.test(file))
    throw new Error("Unsafe packaged filename for uninstall manifest");
  for (const part of file.split("\\")) {
    if (!part || part === "." || part === ".." || /[ .]$/u.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/iu.test(part))
      throw new Error("Unsafe packaged filename for uninstall manifest");
  }
}

async function createProgramManifest(appOutDir) {
  const files = [];
  const unique = new Set();
  async function visit(directory, prefix = "") {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix + item.name;
      validateRelativeFile(relative);
      const full = path.join(directory, item.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) throw new Error("Reparse/symlink in Windows package");
      if (stat.isDirectory()) await visit(full, relative + "\\");
      else if (stat.isFile()) {
        const key = relative.toLowerCase();
        if (unique.has(key)) throw new Error("Case-colliding packaged filename");
        unique.add(key);
        files.push(relative);
      } else throw new Error("Non-regular packaged file");
    }
  }
  await visit(appOutDir);
  if (!files.includes("NeoRead.exe") || !files.includes("resources\\app.asar"))
    throw new Error("Incomplete NeoRead Windows package; refusing to build an unsafe uninstaller");
  return { schema: 1, files: files.sort() };
}

async function assertReviewedTemplates(templateDir) {
  for (const [file, expected] of Object.entries(reviewedTemplates)) {
    const source = (await fs.readFile(path.join(templateDir, file), "utf8")).replace(/\r\n/g, "\n");
    const actual = createHash("sha256").update(source).digest("hex");
    if (actual !== expected) throw new Error(`NSIS protection hook contract changed: ${file}; review required`);
  }
}

async function prepare({ appOutDir, buildResourcesDir, templateDir, arch }) {
  if (!["x64", "ia32", "arm64"].includes(arch)) throw new Error("Unsupported protection manifest architecture");
  await assertReviewedTemplates(templateDir);
  const manifest = await createProgramManifest(appOutDir);
  // JSON is embedded as an opaque File, never interpolated into NSIS instructions.
  // Thus packaged names cannot inject NSIS variables/macros/commands.
  await fs.writeFile(path.join(buildResourcesDir, `program-files-${arch}.json`), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const builder = require.resolve("electron-builder");
  const lib = require.resolve("app-builder-lib/package.json", { paths: [path.dirname(builder)] });
  if (JSON.parse(await fs.readFile(lib, "utf8")).version !== "26.17.0")
    throw new Error("Unreviewed app-builder-lib version; upgrade protection review required");
  const arch = { 0: "ia32", 1: "x64", 3: "arm64" }[context.arch];
  await prepare({
    appOutDir: context.appOutDir,
    buildResourcesDir: context.packager.info.buildResourcesDir,
    templateDir: path.join(path.dirname(lib), "templates", "nsis"),
    arch,
  });
}
module.exports = afterPack;
module.exports.prepare = prepare;
module.exports.createProgramManifest = createProgramManifest;
module.exports.validateRelativeFile = validateRelativeFile;
module.exports.assertReviewedTemplates = assertReviewedTemplates;
