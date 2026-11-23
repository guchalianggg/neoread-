import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFile, copyFile } from "node:fs/promises";

const asset = async (path, mime) =>
  `data:${mime};base64,${(await readFile(new URL(path, import.meta.url))).toString("base64")}`;
const readerIcon = await asset("../web/public/reader-icon.svg", "image/svg+xml");
const startupAssets = {
  // The historical font subset does not contain the full Reader wordmark.
  fontDataURL: "",
  logoLightDataURL: readerIcon,
  logoDarkDataURL: readerIcon,
};
let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
} catch {}
await build({
  entryPoints: ["main/entry.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/entry.cjs",
  external: ["electron", "./main.cjs"],
  define: { NEOREAD_STARTUP_ASSETS: JSON.stringify(startupAssets) },
});
await build({
  entryPoints: ["main/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/main.cjs",
  external: ["electron"],
  define: {
    NEOREAD_BUILD_COMMIT: JSON.stringify(commit),
    NEOREAD_STARTUP_ASSETS: JSON.stringify(startupAssets),
  },
});
await build({
  entryPoints: ["preload/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/preload.cjs",
  external: ["electron"],
});

// Included by builder.config.cjs dist/**/* alongside the embedded font.
await copyFile(
  new URL("../../assets/fonts/caveat/OFL.txt", import.meta.url),
  "dist/LICENSE-Caveat.txt",
);

await build({
  entryPoints: ["preload/migration.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/migration-preload.cjs",
  external: ["electron"],
});
