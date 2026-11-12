import { expect, it } from "vitest";
import { defaultTheme } from "@neoread/core";
import { pdfObjectColors } from "./pdf-dark-mode";

it("maps solid paper and ink once per palette and keeps transparent colors", () => {
  const theme = { ...defaultTheme, mode: "dark" as const };
  const colors = pdfObjectColors(theme)!;
  expect(colors.mapColor("#ffffff")).toBe(colors.background);
  expect(colors.mapColor("#000000")).toBe(colors.foreground);
  expect(colors.mapColor("transparent")).toBe("transparent");
  expect(pdfObjectColors({ ...theme })).toBe(colors);
  expect(pdfObjectColors({ ...theme, mode: "light" })).toBeNull();
  expect(
    pdfObjectColors({ ...theme, pdfDarkContrast: "high" })!.mapColor("#000000"),
  ).toBe("#ffffff");
});
