import { describe, expect, it } from "vitest";
import {
  acceptsDocumentFile,
  documentFilePattern,
  documentImportAccept,
  documentImportExtensions,
} from "./import-formats";

describe("document import formats", () => {
  it.each([
    "survey.md",
    "survey.MARKDOWN",
    "comparison.xlsx",
    "comparison.XLS",
    "paper.PDF",
    "summary.doc",
    "review.DOCX",
  ])("accepts %s in both libraries", (name) => {
    expect(acceptsDocumentFile(name, "papers")).toBe(true);
    expect(acceptsDocumentFile(name, "books")).toBe(true);
    expect(documentFilePattern.test(name)).toBe(true);
  });

  it("keeps direct EPUB imports in the book library", () => {
    expect(acceptsDocumentFile("book.EPUB", "books")).toBe(true);
    expect(acceptsDocumentFile("book.EPUB", "papers")).toBe(false);
  });

  it.each([
    "comparison.xlsx.exe",
    "paper.pdf?download=1",
    "xls",
    "notes.txt",
    "report.csv",
  ])("rejects unsupported or disguised name %s", (name) => {
    expect(acceptsDocumentFile(name, "books")).toBe(false);
    expect(acceptsDocumentFile(name, "papers")).toBe(false);
    expect(documentFilePattern.test(name)).toBe(false);
  });

  it.each(["books", "papers"] as const)(
    "keeps the %s picker and drop filters aligned",
    (library) => {
      const extensions = documentImportExtensions(library);
      expect(documentImportAccept(library)).toBe(
        extensions.map((ext) => `.${ext}`).join(","),
      );
      for (const extension of extensions) {
        expect(acceptsDocumentFile(`file.${extension}`, library)).toBe(true);
        expect(documentFilePattern.test(`file.${extension}`)).toBe(true);
      }
    },
  );
});
