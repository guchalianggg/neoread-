import type { ReaderTheme } from "@neoread/core";

/** "soft" is graphite, recolored onto the dark theme's warm surface; "high" is pure black. */
export type PDFDarkContrast = "high" | "soft";

/** Lightness of recolored paper and ink. */
const lightness = {
  high: [0, 1],
  soft: [0.18, 0.86],
} satisfies Record<PDFDarkContrast, [number, number]>;

/** Tinted paper and ink, replacing the neutral grays at the lightness ends. */
const tints: Partial<
  Record<PDFDarkContrast, { paper: number[]; ink: number[] }>
> = {
  soft: { paper: [0x2f, 0x2c, 0x2f], ink: [0xdc, 0xd7, 0xd2] },
};
const tintTables = new Map<PDFDarkContrast, Uint8Array[] | null>();
/** Per-channel lookup from a neutral recolored value to the tinted one. */
function tintChannels(contrast: PDFDarkContrast) {
  if (tintTables.has(contrast)) return tintTables.get(contrast)!;
  const tint = tints[contrast];
  const [paper, ink] = lightness[contrast].map((value) => value * 255);
  const tables = tint
    ? [0, 1, 2].map((channel) =>
        Uint8Array.from({ length: 256 }, (_, value) =>
          Math.max(
            0,
            Math.min(
              255,
              Math.round(
                tint.paper[channel] +
                  ((tint.ink[channel] - tint.paper[channel]) *
                    (value - paper)) /
                    (ink - paper),
              ),
            ),
          ),
        ),
      )
    : null;
  tintTables.set(contrast, tables);
  return tables;
}

export function pdfDarkPalette(contrast: PDFDarkContrast = "soft") {
  return contrast === "high"
    ? { background: "#000000", foreground: "#ffffff" }
    : { background: "#2f2c2f", foreground: "#dcd7d2" };
}

export interface PDFDarkRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rgbToHsl(r: number, g: number, b: number) {
  ((r /= 255), (g /= 255), (b /= 255));
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  const l = (max + min) / 2;
  let s = 0;
  if (delta) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h /= 6;
    if (h < 0) h++;
  }
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number) {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = h * 6;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [r, g, b] =
    section < 1
      ? [chroma, x, 0]
      : section < 2
        ? [x, chroma, 0]
        : section < 3
          ? [0, chroma, x]
          : section < 4
            ? [0, x, chroma]
            : section < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = l - chroma / 2;
  return [r, g, b].map((channel) => Math.round((channel + m) * 255));
}

/** Adapt grayscale to the selected contrast while preserving colored hues. */
export function adaptPDFColor(
  r: number,
  g: number,
  b: number,
  contrast: PDFDarkContrast = "soft",
) {
  const { h, s, l } = rgbToHsl(r, g, b);
  const [paper, ink] = lightness[contrast];
  let nextL = paper + (ink - paper) * (1 - l);
  // HSL saturation is unstable near white. Use absolute chroma and a smooth
  // transition so barely tinted antialiasing pixels cannot become bright halos.
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  const weight = Math.max(0, Math.min(1, (chroma - 12) / 36));
  nextL += weight * (Math.min(0.87, Math.max(0.64, nextL)) - nextL);
  const rgb = hslToRgb(
    h,
    s * weight,
    contrast === "high" ? nextL : Math.min(ink, Math.max(paper, nextL)),
  );
  const tint = tintChannels(contrast);
  return tint ? rgb.map((value, channel) => tint[channel][value]) : rgb;
}

/** Consumed by the pinned PDF.js patch, entirely on the renderer thread. */
export interface PDFObjectColors {
  background: string;
  foreground: string;
  mapColor: (color: string) => string;
}
const palettes = new Map<PDFDarkContrast, PDFObjectColors>();
export function pdfObjectColors(theme: ReaderTheme): PDFObjectColors | null {
  if (theme.mode !== "dark") return null;
  const contrast = theme.pdfDarkContrast ?? "soft";
  let palette = palettes.get(contrast);
  if (!palette) {
    const colors = new Map<string, string>();
    palette = {
      ...pdfDarkPalette(contrast),
      mapColor(color) {
        const cached = colors.get(color);
        if (cached) return cached;
        // PDF.js normalizes solid drawing colors to hex. Patterns and images
        // are separate drawing objects and must not be flattened/recolored.
        if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
        const rgb = [1, 3, 5].map((offset) =>
          parseInt(color.slice(offset, offset + 2), 16),
        );
        const mapped = adaptPDFColor(rgb[0], rgb[1], rgb[2], contrast);
        const result =
          "#" +
          mapped
            .map((channel) => channel.toString(16).padStart(2, "0"))
            .join("");
        // Bound cache growth for PDFs with thousands of individually colored paths.
        if (colors.size < 4096) colors.set(color, result);
        return result;
      },
    };
    palettes.set(contrast, palette);
  }
  return palette;
}
