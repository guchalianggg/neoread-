import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { runCommand } = require("./protocol.js");
const { createDocument, neoReadCode } = require("./word-document.js");

const MAIN = 1;
const FOOTNOTES = 2;

/** Just enough of the Word object model for the citation client. */
function fakeWord() {
  const formats = [];
  const collection = (items) => ({
    get Count() {
      return items.length;
    },
    Item: (i) => items[i - 1],
    items,
  });
  function range(story, start, end) {
    const r = {
      StoryType: story,
      Start: start,
      End: end,
      Font: {},
      ParagraphFormat: { TabStops: { ClearAll() {}, Add() {} } },
      Collapse() {
        r.Start = r.End;
      },
      SetRange(s, e) {
        r.Start = s;
        r.End = e;
      },
      get Duplicate() {
        const copy = range(story, r.Start, r.End);
        // Formatting set on a duplicate is recorded with its span.
        copy.Font = new Proxy(
          {},
          {
            set(_, key, value) {
              formats.push({ start: copy.Start, end: copy.End, key, value });
              return true;
            },
          },
        );
        return copy;
      },
    };
    return r;
  }
  let nextPosition = 1000;
  function field(story, position, code, fields) {
    const result = range(story, position + 1, position + 1);
    let text = "";
    Object.defineProperty(result, "Text", {
      get: () => text,
      set: (value) => {
        text = value;
        result.End = result.Start + value.length;
      },
    });
    const f = {
      Code: { Text: ` ${code} `, Start: position },
      Result: result,
      unlinked: false,
      Unlink() {
        f.unlinked = true;
        fields.splice(fields.indexOf(f), 1);
      },
      Delete() {
        fields.splice(fields.indexOf(f), 1);
      },
    };
    return f;
  }
  const mainFields = [];
  const footnotes = [];
  const props = [];
  const selection = {
    StoryType: MAIN,
    Start: 500,
    End: 500,
    get Range() {
      return range(selection.StoryType, selection.Start, selection.End);
    },
    SetRange(s, e) {
      selection.Start = s;
      selection.End = e;
    },
    Collapse() {
      selection.Start = selection.End;
    },
  };
  // Selecting puts the selection on the main-text range of a field or reference.
  const select = (start, end) => () => {
    selection.StoryType = MAIN;
    selection.SetRange(start(), end());
  };
  const doc = {
    FullName: "/tmp/paper.docx",
    ReadOnly: false,
    Fields: Object.assign(collection(mainFields), {
      Add(target, type, text) {
        expect(type).toBe(-1);
        const fields =
          target.StoryType === MAIN
            ? mainFields
            : footnotes.find((n) => n.Range === target).Range.Fields.items;
        const f = field(target.StoryType, target.Start, text, fields);
        f.Select = select(
          () => f.Code.Start,
          () => f.Result.End + 1,
        );
        fields.push(f);
        fields.sort((a, b) => a.Code.Start - b.Code.Start);
        return f;
      },
    }),
    Footnotes: Object.assign(collection(footnotes), {
      Add(at) {
        const note = {
          Index: footnotes.length + 1,
          Reference: { Start: at.Start, End: at.Start + 1 },
          Range: range(FOOTNOTES, nextPosition, nextPosition + 10),
        };
        nextPosition += 100;
        note.Range.Fields = collection([]);
        note.Reference.Select = select(
          () => note.Reference.Start,
          () => note.Reference.End,
        );
        footnotes.push(note);
        return note;
      },
    }),
    Endnotes: collection([]),
    CustomDocumentProperties: Object.assign(collection(props), {
      Add(name, _link, type, value) {
        expect(type).toBe(4);
        const prop = {
          Name: name,
          Value: value,
          Delete: () => props.splice(props.indexOf(prop), 1),
        };
        props.push(prop);
      },
    }),
    ActiveWindow: { Activate() {} },
  };
  return {
    app: { ActiveDocument: doc, Selection: selection },
    doc,
    mainFields,
    footnotes,
    props,
    formats,
    selection,
  };
}

it("recognizes NeoRead codes with or without ADDIN", () => {
  expect(neoReadCode(" ADDIN NEOREAD_CITATION {} ")).toBe("NEOREAD_CITATION {}");
  expect(neoReadCode("NEOREAD_BIBLIOGRAPHY")).toBe("NEOREAD_BIBLIOGRAPHY");
  expect(neoReadCode(" ADDIN ZOTERO_ITEM CSL_CITATION {} ")).toBeNull();
  expect(neoReadCode(" PAGE ")).toBeNull();
});

it("inserts, formats and reads back fields in reading order", () => {
  const word = fakeWord();
  const document = createDocument(word.app);
  // One citation in the text, then one in a footnote placed before it.
  expect(
    document.execute({
      op: "Document.insertField",
      kind: "citation",
      noteType: 0,
    }),
  ).toEqual({ index: 0 });
  document.execute({
    op: "Document.updateFields",
    updates: [
      {
        index: 0,
        code: 'NEOREAD_CITATION {"a":1}',
        text: [
          { text: "(Vaswani " },
          { text: "et al.", i: true },
          { text: ", 2017)" },
        ],
      },
    ],
  });
  word.selection.SetRange(100, 100);
  expect(
    document.execute({
      op: "Document.insertField",
      kind: "citation",
      noteType: 1,
    }),
  ).toEqual({ index: 0 });
  const state = document.execute({ op: "Document.getState" });
  expect(state.fields).toEqual([
    { code: "NEOREAD_TEMP", text: "{Citation}", noteIndex: 1 },
    {
      code: 'NEOREAD_CITATION {"a":1}',
      text: "(Vaswani et al., 2017)",
      noteIndex: 0,
    },
  ]);
  // The selection moved past the new note reference.
  expect(state.fieldsBefore).toBe(1);
  expect(word.mainFields[0].Code.Text).toBe(' ADDIN NEOREAD_CITATION {"a":1} ');
  const start = word.mainFields[0].Result.Start;
  expect(word.formats).toEqual([
    { start: start + 9, end: start + 15, key: "Italic", value: true },
  ]);
});

it("finds the field at the cursor", () => {
  const word = fakeWord();
  const document = createDocument(word.app);
  document.execute({
    op: "Document.insertField",
    kind: "citation",
    noteType: 0,
  });
  const field = word.mainFields[0];
  word.selection.SetRange(field.Result.Start + 2, field.Result.Start + 2);
  expect(document.execute({ op: "Document.getState" }).cursor).toBe(0);
  word.selection.SetRange(10, 10);
  expect(document.execute({ op: "Document.getState" })).toMatchObject({
    cursor: null,
    fieldsBefore: 0,
  });
});

it("splits document data into 255-character properties", () => {
  const word = fakeWord();
  const document = createDocument(word.app);
  const data = JSON.stringify({ text: "x".repeat(600) });
  document.execute({ op: "Document.setData", data });
  expect(word.props.map((p) => p.Name)).toEqual([
    "NEOREAD_PREF_1",
    "NEOREAD_PREF_2",
    "NEOREAD_PREF_3",
  ]);
  expect(document.execute({ op: "Document.getState" }).data).toBe(data);
  document.execute({ op: "Document.setData", data: "" });
  expect(word.props).toEqual([]);
});

it("writes bibliography entries as paragraphs and unlinks fields", () => {
  const word = fakeWord();
  const document = createDocument(word.app);
  document.execute({
    op: "Document.insertField",
    kind: "bibliography",
    noteType: 0,
  });
  document.execute({
    op: "Document.updateFields",
    updates: [
      {
        index: 0,
        code: "NEOREAD_BIBLIOGRAPHY {}",
        bibliography: {
          entries: [[{ text: "[1]\tA." }], [{ text: "[2]\tB." }]],
          format: {
            hangingIndent: false,
            secondFieldAlign: "flush",
            maxOffset: 3,
            lineSpacing: 1,
            entrySpacing: 0,
          },
        },
      },
    ],
  });
  const field = word.mainFields[0];
  expect(field.Result.Text).toBe("[1]\tA.\r[2]\tB.");
  expect(field.Result.Style).toBe(-266);
  expect(field.Result.ParagraphFormat.FirstLineIndent).toBeLessThan(0);
  document.execute({
    op: "Document.removeFields",
    indexes: [0],
    keepText: true,
  });
  expect(field.unlinked).toBe(true);
});

it("runs a command until NeoRead completes it and reports errors", async () => {
  const word = fakeWord();
  const document = createDocument(word.app);
  const sent = [];
  const replies = [
    { op: "Document.wait", transaction: "t" },
    { op: "Document.getState", transaction: "t" },
    { op: "Document.unknown", transaction: "t" },
    { op: "Document.complete", transaction: "t", activate: true, error: "" },
  ];
  let activated = false;
  const error = await runCommand({
    command: "refresh",
    documentId: "doc",
    client: "wps",
    document: { ...document, activate: () => (activated = true) },
    post: async (path, body) => {
      sent.push([path, body]);
      return replies.shift();
    },
  });
  expect(error).toBe("");
  expect(activated).toBe(true);
  expect(sent[0]).toEqual([
    "/v1/cite/execCommand",
    { command: "refresh", documentId: "doc", client: "wps" },
  ]);
  expect(sent[1]).toEqual(["/v1/cite/next", { transaction: "t" }]);
  expect(sent[2][1]).toMatchObject({
    transaction: "t",
    result: { fields: [] },
  });
  expect(sent[3][1]).toEqual({
    transaction: "t",
    error: "插件版本过旧，请在 NeoRead 设置中重新安装",
  });
});

it("bootstraps with a private installation path and uses only the runtime credential for commands", async () => {
  const key = "a".repeat(64);
  const token = "b".repeat(64);
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ credential: token }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ op: "Document.complete" }),
    });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const { bootstrap } = require("./protocol.js");
    await expect(bootstrap("")).rejects.toThrow("重新安装");
    expect(fetchMock).not.toHaveBeenCalled();
    const post = await bootstrap("/wps/" + key + "/index.html");
    await post("/v1/cite/execCommand", { command: "refresh" });
    expect(fetchMock.mock.calls[0][0]).toBe("/v1/cite/bootstrap");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer " + key,
    );
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
      "Bearer " + token,
    );
    expect(fetchMock.mock.calls.every(([url]) => !url.includes(key))).toBe(
      true,
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

function threeCitations() {
  const word = fakeWord();
  for (const [i, name] of ["A", "B", "C"].entries()) {
    const field = word.doc.Fields.Add(
      { StoryType: MAIN, Start: 100 * (i + 1) },
      -1,
      "ADDIN NEOREAD_CITATION " + name,
    );
    field.Result.Text = name;
  }
  const document = createDocument(word.app);
  document.execute({ op: "Document.getState" });
  return { word, document };
}

it.each(["update", "delete", "unlink"])(
  "rejects %s after an earlier citation is deleted without touching other fields",
  (operation) => {
    const { word, document } = threeCitations();
    const [, b, c] = word.mainFields;
    word.mainFields[0].Delete();
    const op = operation === "update"
      ? { op: "Document.updateFields", updates: [{ index: 1, code: "NEOREAD_CITATION changed", text: [{ text: "changed" }] }] }
      : { op: "Document.removeFields", indexes: [1], keepText: operation === "unlink" };
    expect(() => document.execute(op)).toThrow("文档中的域已改变");
    expect(word.mainFields).toEqual([b, c]);
    expect(b.Result.Text).toBe("B");
    expect(c.Result.Text).toBe("C");
    expect(c.Code.Text).toContain("NEOREAD_CITATION C");
  },
);

it("validates every field before applying any updates", () => {
  const { word, document } = threeCitations();
  word.mainFields[2].Code.Text = "ADDIN NEOREAD_CITATION edited";
  expect(() => document.execute({
    op: "Document.updateFields",
    updates: [
      { index: 0, code: "NEOREAD_CITATION changed" },
      { index: 2, code: "NEOREAD_CITATION overwritten" },
    ],
  })).toThrow("文档中的域已改变");
  expect(word.mainFields[0].Code.Text).toContain("NEOREAD_CITATION A");
  expect(word.mainFields[2].Code.Text).toContain("NEOREAD_CITATION edited");
});

it("rejects invalid batch indexes before writing valid entries", () => {
  const { word, document } = threeCitations();
  expect(() => document.execute({
    op: "Document.updateFields",
    updates: [{ index: 0, code: "NEOREAD_CITATION changed" }, { index: 3, code: "NEOREAD_CITATION invalid" }],
  })).toThrow("文档中的域已改变");
  expect(word.mainFields[0].Code.Text).toContain("NEOREAD_CITATION A");
});

it("detects a replacement even when the field count stays unchanged", () => {
  const { word, document } = threeCitations();
  word.mainFields[1].Delete();
  word.doc.Fields.Add({ StoryType: MAIN, Start: 200 }, -1, "ADDIN NEOREAD_CITATION replacement");
  expect(() => document.execute({ op: "Document.removeFields", indexes: [1], keepText: false }))
    .toThrow("文档中的域已改变");
  expect(word.mainFields).toHaveLength(3);
  expect(word.mainFields[1].Code.Text).toContain("replacement");
});

it("keeps captured fields valid when ordinary text shifts their ranges", () => {
  const { word, document } = threeCitations();
  for (const field of word.mainFields) field.Code.Start += 20;
  document.execute({ op: "Document.updateFields", updates: [{ index: 1, code: "NEOREAD_CITATION changed" }] });
  document.execute({ op: "Document.removeFields", indexes: [1], keepText: true });
  expect(word.mainFields.map((field) => field.Result.Text)).toEqual(["A", "C"]);
});

it("validates removal indexes before deleting any field", () => {
  const { word, document } = threeCitations();
  expect(() => document.execute({ op: "Document.removeFields", indexes: [0, 3], keepText: false }))
    .toThrow("文档中的域已改变");
  expect(word.mainFields).toHaveLength(3);
});


it("preserves mixed legacy field codes and detects prefix-only edits", () => {
  const word = fakeWord();
  word.doc.Fields.Add({ StoryType: MAIN, Start: 20 }, -1, "ADDIN READER_CITATION old");
  word.doc.Fields.Add({ StoryType: MAIN, Start: 60 }, -1, "ADDIN NEOREAD_BIBLIOGRAPHY {}");
  const document = createDocument(word.app);
  expect(document.execute({ op: "Document.getState" }).fields.map((f) => f.code)).toEqual([
    "READER_CITATION old", "NEOREAD_BIBLIOGRAPHY {}",
  ]);
  word.mainFields[0].Code.Text = "ADDIN NEOREAD_CITATION old";
  expect(() => document.execute({ op: "Document.updateFields", updates: [{ index: 0, code: "NEOREAD_CITATION changed" }] })).toThrow("文档中的域已改变");
  document.execute({ op: "Document.getState" });
  document.execute({ op: "Document.updateFields", updates: [{ index: 0, code: "NEOREAD_CITATION changed" }] });
  expect(word.mainFields[0].Code.Text).toContain("NEOREAD_CITATION changed");
  expect(neoReadCode("ADDIN READER_TEMP")).toBe("READER_TEMP");
});

it("reads legacy preference chunks, prefers new chunks and removes both on save", () => {
  const word = fakeWord();
  const props = word.doc.CustomDocumentProperties;
  props.Add("READER_PREF_2", false, 4, "two");
  props.Add("READER_PREF_1", false, 4, "one");
  props.Add("OTHER", false, 4, "keep");
  const document = createDocument(word.app);
  expect(document.execute({ op: "Document.getState" }).data).toBe("onetwo");
  props.Add("NEOREAD_PREF_1", false, 4, "new");
  expect(document.execute({ op: "Document.getState" }).data).toBe("new");
  document.execute({ op: "Document.setData", data: "saved" });
  expect(word.props.map((p) => p.Name)).toEqual(["OTHER", "NEOREAD_PREF_1"]);
  expect(document.execute({ op: "Document.getState" }).data).toBe("saved");
  document.execute({ op: "Document.setData", data: "" });
  expect(word.props.map((p) => p.Name)).toEqual(["OTHER"]);
});
