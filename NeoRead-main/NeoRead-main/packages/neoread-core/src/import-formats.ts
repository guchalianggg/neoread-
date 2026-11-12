/** Formats accepted by file pickers, drag/drop and desktop Open with. */
export const documentFilePattern =
  /\.(pdf|epub|md|markdown|xlsx|xls|doc|docx)$/i;

export function documentImportExtensions(library: "books" | "papers") {
  return library === "papers"
    ? ["pdf", "md", "markdown", "xlsx", "xls", "doc", "docx"]
    : ["pdf", "epub", "md", "markdown", "xlsx", "xls", "doc", "docx"];
}

export function acceptsDocumentFile(name: string, library: "books" | "papers") {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return (
    name.includes(".") && documentImportExtensions(library).includes(extension)
  );
}

export function documentImportAccept(library: "books" | "papers") {
  return documentImportExtensions(library)
    .map((extension) => `.${extension}`)
    .join(",");
}
