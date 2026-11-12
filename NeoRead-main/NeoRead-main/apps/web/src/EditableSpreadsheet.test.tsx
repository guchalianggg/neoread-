// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditableSpreadsheet } from "./EditableSpreadsheet";
import {
  addSheet,
  columnName,
  parseTSV,
  setSheetCells,
  validateSheets,
  type SourceSheet,
} from "./source-spreadsheet";

let root: Root, host: HTMLDivElement;
let current: SourceSheet[];
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === text,
  )!;
const cell = (label: string) =>
  host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const paste = (input: HTMLInputElement, text: string) => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => text },
  });
  input.dispatchEvent(event);
  return event;
};
async function mount(sheets: SourceSheet[]) {
  function Harness() {
    const [value, setValue] = useState(sheets);
    current = value;
    return <EditableSpreadsheet sheets={value} onChange={setValue} />;
  }
  await act(async () => root.render(<Harness />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("retains edits independently across sheets using existing shadcn tabs and input", async () => {
  await mount([
    { name: "第一表", rows: [["one"]] },
    { name: "第二表", rows: [["two"]] },
  ]);
  await act(async () => type(cell("第一表 A1"), "中文"));
  await act(async () => button("第二表").click());
  await act(async () => type(cell("第二表 A1"), "changed"));
  await act(async () => button("第一表").click());
  expect(cell("第一表 A1").value).toBe("中文");
  expect(current[1].rows[0][0]).toBe("changed");
  expect(host.querySelector('[data-slot="tabs"]')).not.toBeNull();
  expect(host.querySelector('[data-slot="table"]')).not.toBeNull();
});

it("pastes TSV into a target rectangle, blocking native single-input paste", async () => {
  await mount([{ name: "表", rows: [["keep", "target"]] }]);
  let event!: Event;
  await act(async () => {
    event = paste(cell("表 B1"), "a\tb\r\nc\td\r\n");
  });
  expect(event.defaultPrevented).toBe(true);
  expect(current[0].rows).toEqual([
    ["keep", "a", "b"],
    ["", "c", "d"],
  ]);
  expect(cell("表 C2").value).toBe("d");
});

it("preserves and edits multiline cell strings using the existing Textarea", async () => {
  await mount([{ name: "表", rows: [["line1\nline2"]] }]);
  const input = host.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="表 A1"]',
  )!;
  expect(input.value).toBe("line1\nline2");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, "changed\nline2");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(current[0].rows[0][0]).toBe("changed\nline2");
});

it("rejects an oversized paste atomically without trimming or replacing input", async () => {
  await mount([{ name: "表", rows: [["original"]] }]);
  let event!: Event;
  await act(async () => {
    event = paste(cell("表 A1"), Array(257).fill("x").join("\t"));
  });
  expect(event.defaultPrevented).toBe(true);
  expect(current[0].rows).toEqual([["original"]]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("256");
});

it("adds rows, columns and sheets without losing existing values", async () => {
  await mount([{ name: "表", rows: [["keep"]] }]);
  await act(async () => button("添加行").click());
  await act(async () => button("添加列").click());
  expect(current[0].rows.length).toBe(2);
  expect(cell("表 B2").value).toBe("");
  await act(async () => button("添加工作表").click());
  expect(current).toHaveLength(2);
  expect(current[0].rows[0][0]).toBe("keep");
  expect(cell("工作表2 A1")).not.toBeNull();
});

it("bounds mounted inputs to 100 rows by 20 columns and navigates pages by keyboard", async () => {
  await mount([
    {
      name: "表",
      rows: Array.from({ length: 101 }, (_, i) =>
        Array.from({ length: 21 }, (_, j) => `${i},${j}`),
      ),
    },
  ]);
  expect(host.querySelectorAll("input")).toHaveLength(2000);
  await act(async () => {
    cell("表 A100").focus();
    cell("表 A100").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(cell("表 A101").value).toBe("100,0");
  expect(document.activeElement).toBe(cell("表 A101"));
  await act(async () => button("后 20 列").click());
  expect(cell("表 U101").value).toBe("100,20");
  expect(host.querySelectorAll("input")).toHaveLength(1);
});

it("does not calculate formula-like strings or fetch external links", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await mount([
    { name: "表", rows: [['=WEBSERVICE("https://example.test")']] },
  ]);
  expect(cell("表 A1").value).toContain("=WEBSERVICE");
  expect(fetch).not.toHaveBeenCalled();
});

it("counts holes and all sheet rectangles when enforcing the 200000-cell limit", () => {
  const sheets: SourceSheet[] = [
    {
      name: "A",
      rows: Array.from({ length: 1000 }, () => Array(100).fill("")),
    },
    {
      name: "B",
      rows: Array.from({ length: 1000 }, () => Array(100).fill("")),
    },
  ];
  expect(() => validateSheets(sheets)).not.toThrow();
  expect(() => setSheetCells(sheets, 0, 1000, 0, [["overflow"]])).toThrow(
    "200000",
  );
  const sparse = [
    {
      name: "holes",
      rows: Array.from({ length: 1000 }, (_, i) =>
        i === 999 ? Array(201).fill("") : [],
      ),
    },
  ];
  expect(() => validateSheets(sparse)).toThrow("200000");
  expect(sheets[0].rows.length).toBe(1000);
});

it("enforces row, column and sheet caps with no silent truncation", () => {
  const sheet = [{ name: "A", rows: [["keep"]] }];
  expect(() => setSheetCells(sheet, 0, 10000, 0, [["x"]])).toThrow("10000");
  expect(() => setSheetCells(sheet, 0, 0, 256, [["x"]])).toThrow("256");
  expect(() => setSheetCells(sheet, 0, 9999, 0, [["valid"]])).not.toThrow();
  expect(() => setSheetCells(sheet, 0, 0, 255, [["valid"]])).not.toThrow();
  expect(() =>
    addSheet(
      Array.from({ length: 64 }, (_, i) => ({ name: `${i}`, rows: [[""]] })),
    ),
  ).toThrow("64");
  expect(sheet[0].rows).toEqual([["keep"]]);
});

it("parses quoted TSV and names columns correctly", () => {
  expect(parseTSV('"tab\there"\t"line1\nline2"\n"say ""hi"""\t\n')).toEqual([
    ["tab\there", "line1\nline2"],
    ['say "hi"', ""],
  ]);
  expect(parseTSV("a\tb\n\n")).toEqual([["a", "b"], [""]]);
  expect(() => parseTSV('"unfinished')).toThrow("引号");
  expect([0, 25, 26, 255].map(columnName)).toEqual(["A", "Z", "AA", "IV"]);
});
