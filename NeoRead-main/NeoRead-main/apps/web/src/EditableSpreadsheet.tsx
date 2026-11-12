import { useEffect, useRef, useState } from "react";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import { Textarea } from "@neoread/ui/components/textarea";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@neoread/ui/components/table";
import {
  addSheet,
  columnName,
  parseTSV,
  setSheetCells,
  sheetSize,
  type SourceSheet,
} from "./source-spreadsheet";

const PAGE_ROWS = 100;
const PAGE_COLUMNS = 20;

export function EditableSpreadsheet({
  sheets,
  disabled = false,
  onChange,
}: {
  sheets: SourceSheet[];
  disabled?: boolean;
  onChange: (sheets: SourceSheet[]) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [pages, setPages] = useState<
    Record<number, { row: number; column: number }>
  >({});
  const [error, setError] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const focus = useRef<{ row: number; column: number } | null>(null);
  const sheetIndex = Math.min(selected, Math.max(0, sheets.length - 1));
  const sheet = sheets[sheetIndex];
  const size = sheet ? sheetSize(sheet) : { rows: 0, columns: 0 };
  const rows = Math.max(1, size.rows),
    columns = Math.max(1, size.columns);
  const page = pages[sheetIndex] ?? { row: 0, column: 0 };
  const rowStart =
    Math.min(page.row, Math.floor((rows - 1) / PAGE_ROWS)) * PAGE_ROWS;
  const columnStart =
    Math.min(page.column, Math.floor((columns - 1) / PAGE_COLUMNS)) *
    PAGE_COLUMNS;
  const setPage = (row: number, column: number) =>
    setPages((previous) => ({ ...previous, [sheetIndex]: { row, column } }));
  useEffect(() => {
    const cell = focus.current;
    if (!cell) return;
    host.current
      ?.querySelector<HTMLElement>(
        `[data-row="${cell.row}"][data-column="${cell.column}"]`,
      )
      ?.focus();
    focus.current = null;
  });
  const apply = (operation: () => SourceSheet[]) => {
    if (disabled) return;
    try {
      const next = operation();
      onChange(next);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "无法应用修改，原数据未改变。",
      );
    }
  };
  const move = (row: number, column: number) => {
    if (row < 0 || row >= rows || column < 0 || column >= columns) return;
    focus.current = { row, column };
    setPage(Math.floor(row / PAGE_ROWS), Math.floor(column / PAGE_COLUMNS));
  };
  return (
    <div className="source-spreadsheet" ref={host}>
      <div className="source-sheet-controls">
        <Tabs
          value={sheetIndex}
          onValueChange={(value) => {
            setSelected(Number(value));
            setError("");
          }}
        >
          <TabsList variant="line" aria-label="工作表">
            {sheets.map((item, index) => (
              <TabsTrigger key={index} value={index}>
                {item.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="source-sheet-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() =>
              apply(() => {
                const next = addSheet(sheets);
                setSelected(next.length - 1);
                return next;
              })
            }
          >
            添加工作表
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !sheet}
            onClick={() =>
              apply(() =>
                setSheetCells(sheets, sheetIndex, size.rows, columns - 1, [
                  [""],
                ]),
              )
            }
          >
            添加行
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !sheet}
            onClick={() =>
              apply(() =>
                setSheetCells(sheets, sheetIndex, rows - 1, size.columns, [
                  [""],
                ]),
              )
            }
          >
            添加列
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="source-edit-error">
          {error}
        </p>
      )}
      {!sheet ? (
        <p>暂无工作表，请添加工作表。</p>
      ) : (
        <>
          <div className="source-sheet-grid">
            <Table aria-label={`${sheet.name} 单元格`}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className="source-row-number">
                    行
                  </TableHead>
                  {Array.from(
                    { length: Math.min(PAGE_COLUMNS, columns - columnStart) },
                    (_, offset) => (
                      <TableHead scope="col" key={offset}>
                        {columnName(columnStart + offset)}
                      </TableHead>
                    ),
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from(
                  { length: Math.min(PAGE_ROWS, rows - rowStart) },
                  (_, offset) => {
                    const row = rowStart + offset;
                    return (
                      <TableRow key={row}>
                        <TableHead scope="row" className="source-row-number">
                          {row + 1}
                        </TableHead>
                        {Array.from(
                          {
                            length: Math.min(
                              PAGE_COLUMNS,
                              columns - columnStart,
                            ),
                          },
                          (_, i) => {
                            const column = columnStart + i;
                            const value = sheet.rows[row]?.[column] ?? "";
                            const CellEditor = /[\r\n]/.test(value)
                              ? Textarea
                              : Input;
                            return (
                              <TableCell key={column}>
                                <CellEditor
                                  aria-label={`${sheet.name} ${columnName(column)}${row + 1}`}
                                  data-row={row}
                                  data-column={column}
                                  disabled={disabled}
                                  value={value}
                                  autoComplete="off"
                                  spellCheck={false}
                                  onChange={(event) =>
                                    apply(() =>
                                      setSheetCells(
                                        sheets,
                                        sheetIndex,
                                        row,
                                        column,
                                        [[event.target.value]],
                                      ),
                                    )
                                  }
                                  onPaste={(event) => {
                                    const text =
                                      event.clipboardData.getData("text/plain");
                                    if (!/[\t\r\n]/.test(text)) return;
                                    // Block the native single-input paste before parsing or limit validation.
                                    event.preventDefault();
                                    apply(() =>
                                      setSheetCells(
                                        sheets,
                                        sheetIndex,
                                        row,
                                        column,
                                        parseTSV(text),
                                      ),
                                    );
                                  }}
                                  onKeyDown={(event) => {
                                    if (
                                      event.nativeEvent.isComposing ||
                                      event.repeat ||
                                      disabled ||
                                      event.metaKey ||
                                      event.ctrlKey ||
                                      event.altKey
                                    )
                                      return;
                                    if (CellEditor === Textarea) return; // Preserve native multiline editing.
                                    if (
                                      event.key === "Enter" ||
                                      event.key === "ArrowDown" ||
                                      event.key === "ArrowUp"
                                    ) {
                                      event.preventDefault();
                                      move(
                                        row +
                                          (event.key === "ArrowUp" ||
                                          (event.key === "Enter" &&
                                            event.shiftKey)
                                            ? -1
                                            : 1),
                                        column,
                                      );
                                    }
                                  }}
                                />
                              </TableCell>
                            );
                          },
                        )}
                      </TableRow>
                    );
                  },
                )}
              </TableBody>
            </Table>
          </div>
          <div className="source-sheet-pagination" aria-label="表格分页">
            <Button
              variant="ghost"
              size="sm"
              disabled={rowStart === 0}
              onClick={() =>
                setPage(rowStart / PAGE_ROWS - 1, columnStart / PAGE_COLUMNS)
              }
            >
              上一页
            </Button>
            <span aria-live="polite">
              {rowStart + 1}–{Math.min(rows, rowStart + PAGE_ROWS)} / {rows} 行
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={rowStart + PAGE_ROWS >= rows}
              onClick={() =>
                setPage(rowStart / PAGE_ROWS + 1, columnStart / PAGE_COLUMNS)
              }
            >
              下一页
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={columnStart === 0}
              onClick={() =>
                setPage(rowStart / PAGE_ROWS, columnStart / PAGE_COLUMNS - 1)
              }
            >
              前 20 列
            </Button>
            <span>
              {columnName(columnStart)}–
              {columnName(Math.min(columns, columnStart + PAGE_COLUMNS) - 1)} /{" "}
              {columns} 列
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={columnStart + PAGE_COLUMNS >= columns}
              onClick={() =>
                setPage(rowStart / PAGE_ROWS, columnStart / PAGE_COLUMNS + 1)
              }
            >
              后 20 列
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
