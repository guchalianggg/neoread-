import type { SourceEditSnapshot } from "@neoread/core";

export type SourceSheet = NonNullable<SourceEditSnapshot["sheets"]>[number];
export const SPREADSHEET_LIMITS = {
  sheets: 64,
  rows: 10_000,
  columns: 256,
  cells: 200_000,
} as const;

export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export function sheetSize(sheet: SourceSheet) {
  return {
    rows: sheet.rows.length,
    columns: sheet.rows.reduce((max, row) => Math.max(max, row.length), 0),
  };
}

// Count each sheet's entire bounding rectangle, including empty cells/holes.
export function validateSheets(sheets: SourceSheet[]): void {
  if (sheets.length > SPREADSHEET_LIMITS.sheets)
    throw new Error("最多 64 个工作表，未应用此次修改。");
  let cells = 0;
  for (const sheet of sheets) {
    const size = sheetSize(sheet);
    if (size.rows > SPREADSHEET_LIMITS.rows)
      throw new Error("每个工作表最多 10000 行，未应用此次修改。");
    if (size.columns > SPREADSHEET_LIMITS.columns)
      throw new Error("每个工作表最多 256 列，未应用此次修改。");
    cells += size.rows * size.columns;
  }
  if (cells > SPREADSHEET_LIMITS.cells)
    throw new Error(
      "所有工作表合计最多 200000 个单元格（含空白区域），未应用此次修改。",
    );
}

export function setSheetCells(
  sheets: SourceSheet[],
  sheetIndex: number,
  row: number,
  column: number,
  values: string[][],
): SourceSheet[] {
  const sheet = sheets[sheetIndex];
  if (
    !sheet ||
    row < 0 ||
    column < 0 ||
    !Number.isInteger(row) ||
    !Number.isInteger(column)
  )
    throw new Error("无效的单元格位置。");
  if (!values.length) return sheets;
  const width = values.reduce((max, cells) => Math.max(max, cells.length), 0);
  if (!width) return sheets;
  const oldSize = sheetSize(sheet);
  const rows = Math.max(oldSize.rows, row + values.length);
  const columns = Math.max(oldSize.columns, column + width);
  if (rows > SPREADSHEET_LIMITS.rows || columns > SPREADSHEET_LIMITS.columns)
    throw new Error("超出每表 10000 行或 256 列上限，未应用此次修改。");
  const otherCells = sheets.reduce((count, item, index) => {
    const size = sheetSize(item);
    return count + (index === sheetIndex ? 0 : size.rows * size.columns);
  }, 0);
  if (otherCells + rows * columns > SPREADSHEET_LIMITS.cells)
    throw new Error(
      "所有工作表合计最多 200000 个单元格（含空白区域），未应用此次修改。",
    );
  validateSheets(sheets);
  const nextRows = sheet.rows.slice();
  while (nextRows.length < rows) nextRows.push([]);
  values.forEach((cells, offset) => {
    const next = [...nextRows[row + offset]];
    while (next.length < column + cells.length) next.push("");
    cells.forEach((value, i) => {
      next[column + i] = value;
    });
    nextRows[row + offset] = next;
  });
  const next = sheets.map((item, index) =>
    index === sheetIndex ? { ...item, rows: nextRows } : item,
  );
  validateSheets(next);
  return next;
}

export function addSheet(sheets: SourceSheet[]): SourceSheet[] {
  let number = sheets.length + 1;
  while (sheets.some((sheet) => sheet.name === `工作表${number}`)) number++;
  const next = [...sheets, { name: `工作表${number}`, rows: [[""]] }];
  validateSheets(next);
  return next;
}

/** Excel-style TSV, including quoted tabs/newlines and doubled quotes. */
export function parseTSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  const input = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"' && (quoted || !cell)) {
      if (quoted && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (char === "\t" || char === "\n")) {
      row.push(cell);
      cell = "";
      if (row.length > SPREADSHEET_LIMITS.columns)
        throw new Error("粘贴内容超过 256 列，未应用此次修改。");
      if (char === "\n") {
        rows.push(row);
        row = [];
      }
      if (rows.length > SPREADSHEET_LIMITS.rows)
        throw new Error("粘贴内容超过 10000 行，未应用此次修改。");
    } else cell += char;
  }
  if (quoted) throw new Error("粘贴内容的引号不完整，未应用此次修改。");
  // A clipboard's terminal record separator is not an additional blank row.
  if (cell || row.length || !input.endsWith("\n")) {
    row.push(cell);
    rows.push(row);
  }
  if (
    rows.length > SPREADSHEET_LIMITS.rows ||
    rows.some((cells) => cells.length > SPREADSHEET_LIMITS.columns)
  )
    throw new Error("粘贴内容超过 10000 行或 256 列，未应用此次修改。");
  return rows;
}
