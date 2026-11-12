// Offline operation counts; this does not measure browser frame rate or latency.
// Usage: node scripts/pdf-theme-color-count.mjs /path/to/document.pdf 1 2 10
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const [file, ...pageArgs] = process.argv.slice(2);
const pages = pageArgs.length ? pageArgs.map(Number) : [1];
if (!file || pages.some((page) => !Number.isInteger(page) || page < 1)) {
  throw new Error(
    "Usage: node scripts/pdf-theme-color-count.mjs PDF [PAGE ...]",
  );
}
const require = createRequire(
  new URL("../apps/processor/package.json", import.meta.url),
);
const { createCanvas } = require("@napi-rs/canvas");
const { transformSync } = require("esbuild");
const source = await readFile(
  new URL("../apps/web/src/readers/pdf-dark-mode.ts", import.meta.url),
  "utf8",
);
const { code } = transformSync(source, { loader: "ts", format: "esm" });
const { pdfObjectColors } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
const palette = pdfObjectColors({ mode: "dark", pdfDarkContrast: "soft" });
const { getDocument, OPS } = await import(
  pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"))
);
const data = new Uint8Array(await readFile(file));
const sha256 = createHash("sha256").update(data).digest("hex");
const task = getDocument({ data, useSystemFonts: true, disableFontFace: true });
const output = [];
try {
  const document = await task.promise;
  for (const number of pages) {
    const page = await document.getPage(number);
    const operators = await page.getOperatorList();
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    let calls = 0;
    const colors = new Set();
    try {
      await page.render({
        canvas,
        canvasContext: canvas.getContext("2d"),
        viewport,
        pageColors: {
          ...palette,
          mapColor(color) {
            calls++;
            colors.add(color);
            return palette.mapColor(color);
          },
        },
      }).promise;
      const count = (name) =>
        operators.fnArray.filter((id) => id === OPS[name]).length;
      output.push({
        page: number,
        operators: operators.fnArray.length,
        mappingCalls: calls,
        uniqueSourceColors: colors.size,
        fillColorOperators: count("setFillRGBColor"),
        strokeColorOperators: count("setStrokeRGBColor"),
        textOperators: count("showText"),
      });
    } finally {
      canvas.width = canvas.height = 1;
    }
  }
} finally {
  await task.destroy();
}
console.log(
  JSON.stringify({ node: process.version, sha256, scale: 1, output }, null, 2),
);
