import { posix, win32 } from "node:path";
import { expect, it } from "vitest";
import { documentArguments } from "./open-files";

it("takes documents passed by Windows Open with", () => {
  expect(
    documentArguments(
      [
        "C:\\Program Files\\NeoRead\\NeoRead.exe",
        "--allow-file-access-from-files",
        "D:\\Books\\Notes.PDF",
        "neoread://open?id=0123456789abcdef0123456789abcdef",
        "C:\\Users\\me\\a.epub",
        "C:\\Users\\me\\a.txt",
      ],
      "C:\\Windows\\System32",
      false,
      win32.resolve,
    ),
  ).toEqual(["D:\\Books\\Notes.PDF", "C:\\Users\\me\\a.epub"]);
});

it("resolves relative paths against the launching directory", () => {
  expect(
    documentArguments(
      ["NeoRead.exe", "paper.pdf"],
      "C:\\Users\\me\\Downloads",
      false,
      win32.resolve,
    ),
  ).toEqual(["C:\\Users\\me\\Downloads\\paper.pdf"]);
});

it("skips the entry script of development runs", () => {
  expect(
    documentArguments(
      ["/usr/bin/electron", "/repo/main.pdf", "/tmp/book.epub"],
      "/",
      true,
      posix.resolve,
    ),
  ).toEqual(["/tmp/book.epub"]);
  expect(documentArguments(["/usr/bin/electron", "."], "/", true)).toEqual([]);
});

it("opens Markdown and both Excel formats without accepting disguised extensions", () => {
  expect(
    documentArguments(
      [
        "NeoRead.exe",
        "survey.MD",
        "notes.markdown",
        "compare.XLSX",
        "legacy.xls",
        "table.xlsx.exe",
      ],
      "D:\\Research",
      false,
      win32.resolve,
    ),
  ).toEqual([
    "D:\\Research\\survey.MD",
    "D:\\Research\\notes.markdown",
    "D:\\Research\\compare.XLSX",
    "D:\\Research\\legacy.xls",
  ]);
});
