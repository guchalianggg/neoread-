package neoread

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/xuri/excelize/v2"
	"neoread.local/server/internal/diagnostics"
)

const sourceTestMarkdown = "# Research\n\n## 中文汇总\n\n| 项目 | 数值 |\n| --- | --- |\n| NeoRead | 42 |\n\n- 项目一\n- 项目二\n\n```go\nfmt.Println(42)\n```\n\n<script>alert('PRIVATE_SOURCE_MARKER')</script>\n\n<img src=\"file:///private.png\" onerror=\"alert(1)\">\n\n![外图](https://example.invalid/p.png)\n![本地图](../secret.png)\n[坏链接](javascript:alert(1))\n"

func sourceTestXLSX(t *testing.T, mode string) []byte {
	t.Helper()
	book := excelize.NewFile()
	defer book.Close()
	if mode != "empty" {
		if err := book.SetSheetName("Sheet1", "中文汇总"); err != nil {
			t.Fatal(err)
		}
		if err := book.SetCellValue("中文汇总", "A1", "NeoRead 中文\n第二行"); err != nil {
			t.Fatal(err)
		}
		_ = book.SetCellValue("中文汇总", "B1", 12.5)
		style, e := book.NewStyle(&excelize.Style{NumFmt: 2})
		if e != nil {
			t.Fatal(e)
		}
		_ = book.SetCellStyle("中文汇总", "B1", "B1", style)
		if _, err := book.NewSheet("第二表"); err != nil {
			t.Fatal(err)
		}
		_ = book.SetCellValue("第二表", "A1", "结论 & <script>")
		if mode == "sparse" {
			_ = book.SetCellValue("第二表", "XFD1048576", "不能截断")
		}
		if mode == "formula" {
			_ = book.SetCellFormula("第二表", "B1", "1+1")
		}
	}
	out, e := book.WriteToBuffer()
	if e != nil {
		t.Fatal(e)
	}
	return out.Bytes()
}

func sourceTestConvert(t *testing.T, kind string, data []byte) ([]byte, error) {
	t.Helper()
	source := filepath.Join(t.TempDir(), "source."+kind)
	if e := os.WriteFile(source, data, 0600); e != nil {
		t.Fatal(e)
	}
	var out bytes.Buffer
	err := convertSource(context.Background(), source, kind, "汇总", "test-id", &out)
	return out.Bytes(), err
}
func sourceTestZIP(t *testing.T, data []byte) map[string]string {
	t.Helper()
	z, e := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if e != nil {
		t.Fatal(e)
	}
	out := map[string]string{}
	for _, f := range z.File {
		r, e := f.Open()
		if e != nil {
			t.Fatal(e)
		}
		b, e := io.ReadAll(r)
		_ = r.Close()
		if e != nil {
			t.Fatal(e)
		}
		out[f.Name] = string(b)
	}
	return out
}
func TestSourceConversionFormats(t *testing.T) {
	for _, tc := range []struct {
		name, kind string
		data       []byte
		want       []string
		chapters   int
	}{
		{"markdown", "md", []byte(sourceTestMarkdown), []string{"<table>", "<h1", "<ul>", "<pre>", "中文汇总", "图片未嵌入"}, 1},
		{"markdown-long-extension", "markdown", []byte("# NeoRead\n\n中文正文"), []string{"中文正文"}, 1},
		{"xlsx", "xlsx", sourceTestXLSX(t, "normal"), []string{"中文", "第二行", "12.50", "<br"}, 2},
		{"binary-xls", "xls", sourceTestBinaryXLS(), []string{"中文", "第二行", "12.5", "42"}, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, e := sourceTestConvert(t, tc.kind, tc.data)
			if e != nil {
				t.Fatal(e)
			}
			again, e := sourceTestConvert(t, tc.kind, tc.data)
			if e != nil || !bytes.Equal(out, again) {
				t.Fatal("conversion is not deterministic", e)
			}
			files := sourceTestZIP(t, out)
			body := files["EPUB/chapter-1.xhtml"]
			for _, w := range tc.want {
				if !strings.Contains(body, w) {
					t.Fatalf("missing %q: %s", w, body)
				}
			}
			if strings.Contains(body, "<script") || strings.Contains(body, "<img") || strings.Contains(body, "javascript:") || strings.Contains(body, "onerror=") {
				t.Fatal("active content survived")
			}
			root := t.TempDir()
			epub := filepath.Join(root, "reading.epub")
			_ = os.WriteFile(epub, out, 0600)
			manifest, texts, e := prepareEPUB(context.Background(), epub, filepath.Join(root, "cache"))
			if e != nil {
				t.Fatal(e)
			}
			if len(texts) != tc.chapters || len(manifest["toc"].([]any)) == 0 {
				t.Fatalf("unreadable index/toc: %v %v", texts, manifest)
			}
		})
	}
}
func TestSourceConversionRejections(t *testing.T) {
	validXLSX := sourceTestXLSX(t, "normal")
	for _, tc := range []struct {
		name, kind string
		data       []byte
		code       string
	}{
		{"empty-md", "md", []byte(" \n"), "empty"}, {"html-only", "md", []byte("<script>alert(1)</script>"), "empty"},
		{"binary-as-md", "md", sourceTestBinaryXLS(), "format"}, {"pdf-as-md", "md", []byte("%PDF-1.7 hello"), "format"},
		{"invalid-utf8", "md", []byte{0xff, 0xfe}, "format"}, {"large-md", "md", bytes.Repeat([]byte("a"), markdownSourceLimit+1), "limit"},
		{"empty-xlsx", "xlsx", sourceTestXLSX(t, "empty"), "empty"}, {"sparse-xlsx", "xlsx", sourceTestXLSX(t, "sparse"), "limit"},
		{"formula-without-cache", "xlsx", sourceTestXLSX(t, "formula"), "formula_cache"},
		{"corrupt-xlsx", "xlsx", validXLSX[:len(validXLSX)/2], "format"}, {"text-as-xlsx", "xlsx", []byte("# not an Excel"), "format"},
		{"xlsx-as-xls", "xls", validXLSX, "format"}, {"xls-as-xlsx", "xlsx", sourceTestBinaryXLS(), "format"},
		{"corrupt-xls", "xls", sourceTestBinaryXLS()[:1024], "corrupt"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := sourceTestConvert(t, tc.kind, tc.data)
			if err == nil || sourceReason(err) != tc.code {
				t.Fatalf("want %s, got %v (%s)", tc.code, err, sourceReason(err))
			}
		})
	}
}
func TestSourceConversionLimitsAndCancellation(t *testing.T) {
	var bomb bytes.Buffer
	z := zip.NewWriter(&bomb)
	w, _ := z.Create("large.xml")
	_, _ = io.Copy(w, io.LimitReader(zeroSourceReader{}, sourceResourceLimit+1))
	_ = z.Close()
	if _, e := sourceTestConvert(t, "xlsx", bomb.Bytes()); sourceReason(e) != "limit" {
		t.Fatal(e)
	}
	for _, xml := range []string{`<worksheet><sheetData><row r="1"><c r="XFD1"><v>1</v></c></row></sheetData></worksheet>`, `<worksheet><sheetData><row r="10001"/></sheetData></worksheet>`, `<worksheet><sheetData><row r="10000"><c r="Z10000"><v>1</v></c></row></sheetData></worksheet>`} {
		if e := validateSheetXML(context.Background(), []byte(xml)); sourceReason(e) != "limit" {
			t.Fatal(e)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var out bytes.Buffer
	if e := convertSource(ctx, "does-not-need-to-exist", "md", "x", "id", &out); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
}

type zeroSourceReader struct{}

func (zeroSourceReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

func TestSourceImportHTTPOriginalAndRestore(t *testing.T) {
	for _, library := range []string{"books", "papers"} {
		for _, tc := range []struct {
			kind string
			data []byte
		}{
			{"md", []byte(sourceTestMarkdown)}, {"markdown", []byte("# NeoRead\n\n独立汇总")}, {"xlsx", sourceTestXLSX(t, "normal")}, {"xls", sourceTestBinaryXLS()},
		} {
			t.Run(library+"/"+tc.kind, func(t *testing.T) {
				s := testServer(t)
				name := "研究汇总." + tc.kind
				w := uploadTo(t, s, library, name, tc.data)
				if w.Code != 201 {
					t.Fatalf("import %d %s", w.Code, w.Body.String())
				}
				var d Document
				if e := json.Unmarshal(w.Body.Bytes(), &d); e != nil {
					t.Fatal(e)
				}
				hash := sha256.Sum256(tc.data)
				if d.ID != hex.EncodeToString(hash[:])[:32] || d.Size != int64(len(tc.data)) || d.Type != "epub" || d.Library != library || d.AttachmentCount != 1 || d.Metadata.Lookup != "done" {
					t.Fatalf("wrong source identity: %+v", d)
				}
				attachments := attachmentList(t, s, d.ID)
				if len(attachments) != 1 || attachments[0].Filename != name {
					t.Fatal(attachments)
				}
				path := "/api/documents/" + d.ID
				download := request(t, s, "GET", path+"/attachments/"+attachments[0].ID+"/file", nil)
				if download.Code != 200 || !bytes.Equal(download.Body.Bytes(), tc.data) {
					t.Fatal("original bytes changed", download.Code)
				}
				file, e := os.ReadFile(s.Store.File(d))
				if e != nil || !bytes.HasPrefix(file, []byte("PK")) {
					t.Fatal("reading copy is not EPUB", e)
				}
				if w = request(t, s, "GET", path+"/search?q="+url.QueryEscape("NeoRead"), nil); w.Code != 200 || w.Body.String() == "[]\n" {
					t.Fatal("not searchable", w.Body.String())
				}
				if w = request(t, s, "GET", "/pub/test-secret/"+d.ID+"/manifest.json", nil); w.Code != 200 || !strings.Contains(w.Body.String(), "toc") {
					t.Fatal("manifest/toc", w.Code, w.Body.String())
				}
				annotation := `{"kind":"highlight","location":{"type":"epub","href":"EPUB/chapter-1.xhtml"},"quote":"keep source note","note":"annotation persists","color":"yellow"}`
				if w = request(t, s, "POST", path+"/annotations", strings.NewReader(annotation)); w.Code != 201 {
					t.Fatal(w.Code, w.Body.String())
				}
				if w = request(t, s, "POST", path+"/trash", nil); w.Code != 200 {
					t.Fatal(w.Code, w.Body.String())
				}
				if w = uploadTo(t, s, library, "renamed."+tc.kind, tc.data); w.Code != 200 {
					t.Fatal(w.Code, w.Body.String())
				}
				restored, e := s.Store.Document(d.ID)
				if e != nil || restored.DeletedAt != "" || restored.AttachmentCount != 1 {
					t.Fatal(restored, e)
				}
				if w = request(t, s, "GET", path+"/annotations", nil); !strings.Contains(w.Body.String(), "annotation persists") {
					t.Fatal("annotation lost", w.Body.String())
				}
				if list := attachmentList(t, s, d.ID); len(list) != 1 || list[0].ID != attachments[0].ID {
					t.Fatal("duplicate attachment", list)
				}
				if library == "books" {
					if w = request(t, s, "PATCH", path, strings.NewReader(`{"library":"papers"}`)); w.Code != 200 {
						t.Fatal("move source", w.Code, w.Body.String())
					}
				}
				if w = request(t, s, "DELETE", path+"/attachments/"+attachments[0].ID, nil); w.Code != 400 {
					t.Fatal("original must remain available", w.Code)
				}
				if w = request(t, s, "DELETE", path, nil); w.Code != 204 {
					t.Fatal("purge", w.Code, w.Body.String())
				}
				if entries, e := os.ReadDir(filepath.Join(s.Store.Root, "attachments")); e != nil || len(entries) != 0 {
					t.Fatal("purge left original", entries, e)
				}
			})
		}
	}
}
func TestSourceImportRollback(t *testing.T) {
	for _, phase := range []string{"invalid", "cache", "dest", "attachment-dest", "document-row", "attachment-row", "index-row", "processing-row", "job-row"} {
		t.Run(phase, func(t *testing.T) {
			s := testServer(t)
			data := []byte("# Rollback\n\nNeoRead 中文正文")
			hash := sha256.Sum256(data)
			h := hex.EncodeToString(hash[:])
			docID := h[:32]
			switch phase {
			case "invalid":
				data = []byte("\x00invalid")
			case "cache":
				_ = os.WriteFile(filepath.Join(s.Store.Root, "cache", docID), []byte("block"), 0600)
			case "dest":
				_ = os.Mkdir(filepath.Join(s.Store.Root, "books", docID+".epub"), 0700)
			case "attachment-dest":
				_ = os.Remove(filepath.Join(s.Store.Root, "attachments"))
				_ = os.WriteFile(filepath.Join(s.Store.Root, "attachments"), []byte("block"), 0600)
			case "index-row":
				if _, e := s.Store.DB.Exec("DROP TABLE search_index; CREATE TABLE search_index(document_id TEXT,href TEXT,content TEXT CHECK(content='forced-fail'))"); e != nil {
					t.Fatal(e)
				}
			default:
				table := map[string]string{"document-row": "documents", "attachment-row": "paper_attachments", "processing-row": "document_processing", "job-row": "document_corpus_jobs"}[phase]
				if _, e := s.Store.DB.Exec("CREATE TRIGGER fail_source BEFORE INSERT ON " + table + " BEGIN SELECT RAISE(ABORT,'test rollback'); END"); e != nil {
					t.Fatal(e)
				}
			}
			w := uploadTo(t, s, "papers", "rollback.md", data)
			if w.Code < 400 {
				t.Fatal("failure accepted", w.Code, w.Body.String())
			}
			for _, table := range []string{"documents", "paper_attachments", "search_index", "document_processing", "document_corpus_jobs"} {
				var n int
				if e := s.Store.DB.QueryRow("SELECT count(*) FROM " + table).Scan(&n); e != nil || n != 0 {
					t.Fatalf("partial %s: %d %v", table, n, e)
				}
			}
			if phase != "dest" {
				if _, e := os.Stat(filepath.Join(s.Store.Root, "books", docID+".epub")); !errors.Is(e, os.ErrNotExist) {
					t.Fatal("orphan reading file", e)
				}
			}
			if entries, e := os.ReadDir(filepath.Join(s.Store.Root, "attachments")); e == nil && len(entries) != 0 {
				t.Fatal("orphan original", entries)
			}
			if entries, e := os.ReadDir(filepath.Join(s.Store.Root, "cache")); e == nil && len(entries) != 0 {
				t.Fatal("orphan cache", entries)
			}
			for _, pattern := range []string{"import-*", "source-*"} {
				files, _ := filepath.Glob(filepath.Join(s.Store.Root, pattern))
				if len(files) != 0 {
					t.Fatal("temporary files", files)
				}
			}
		})
	}
}
func TestSourceConversionDiagnostics(t *testing.T) {
	s := testServer(t)
	dir := t.TempDir()
	logs, e := diagnostics.New(dir, "source-test")
	if e != nil {
		t.Fatal(e)
	}
	s.SetDiagnostics(logs)
	_ = uploadTo(t, s, "papers", "PRIVATE_FILENAME.xlsx", []byte("PRIVATE_CONTENT"))
	_ = uploadTo(t, s, "books", "PRIVATE_FILENAME.md", []byte("# PRIVATE_CONTENT"))
	files, _ := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	var all []byte
	for _, file := range files {
		b, _ := os.ReadFile(file)
		all = append(all, b...)
	}
	for _, want := range []string{"document.source_conversion.start", "document.source_conversion.failed", "document.source_conversion.finish", "reasonCode"} {
		if !bytes.Contains(all, []byte(want)) {
			t.Fatalf("missing diagnostic %s", want)
		}
	}
	if bytes.Contains(all, []byte("PRIVATE_")) {
		t.Fatal("source content or filename leaked into diagnostic")
	}
}

// A real OLE/CFB BIFF8 fixture built entirely in memory (no Excel executable,
// network fixture, user library, or binary asset checked into the repository).
func sourceTestBinaryXLS() []byte {
	u16 := func(v int) []byte { b := make([]byte, 2); binary.LittleEndian.PutUint16(b, uint16(v)); return b }
	u32 := func(v int) []byte { b := make([]byte, 4); binary.LittleEndian.PutUint32(b, uint32(v)); return b }
	record := func(id int, v []byte) []byte { b := append(u16(id), u16(len(v))...); return append(b, v...) }
	unicodeBytes := func(s string) []byte {
		var b []byte
		for _, r := range utf16.Encode([]rune(s)) {
			b = append(b, u16(int(r))...)
		}
		return b
	}
	bof := func(kind int) []byte {
		b := make([]byte, 16)
		copy(b, u16(0x0600))
		copy(b[2:], u16(kind))
		return record(0x0809, b)
	}
	label := func(r, c int, s string) []byte {
		b := append(append(u16(r), u16(c)...), u16(0)...)
		b = append(b, u16(len(utf16.Encode([]rune(s))))...)
		b = append(b, 1)
		return record(0x0204, append(b, unicodeBytes(s)...))
	}
	number := func(r, c int, n float64) []byte {
		b := make([]byte, 14)
		copy(b, u16(r))
		copy(b[2:], u16(c))
		binary.LittleEndian.PutUint64(b[6:], math.Float64bits(n))
		return record(0x0203, b)
	}
	first := append(bof(0x0010), label(0, 0, "NeoRead 中文\n第二行")...)
	first = append(first, number(0, 1, 12.5)...)
	formula := make([]byte, 22)
	copy(formula, u16(1))
	binary.LittleEndian.PutUint64(formula[6:], math.Float64bits(42))
	first = append(first, record(0x0006, formula)...)
	first = append(first, record(0x000a, nil)...)
	second := append(bof(0x0010), label(0, 0, "第二表结论")...)
	second = append(second, record(0x000a, nil)...)
	bound := func(offset int, name string) []byte {
		b := append(u32(offset), 0, 0, byte(len(utf16.Encode([]rune(name)))), 1)
		return record(0x0085, append(b, unicodeBytes(name)...))
	}
	globals := append(bof(0x0005), record(0x0042, u16(1200))...)
	globals = append(globals, record(0x00e0, make([]byte, 20))...)
	start := len(globals) + len(bound(0, "汇总")) + len(bound(0, "数据")) + 4
	globals = append(globals, bound(start, "汇总")...)
	globals = append(globals, bound(start+len(first), "数据")...)
	globals = append(globals, record(0x000a, nil)...)
	stream := append(append(globals, first...), second...)
	stream = append(stream, make([]byte, 4096-len(stream))...)
	header := make([]byte, 512)
	copy(header, []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1})
	copy(header[24:], u16(0x003e))
	copy(header[26:], u16(3))
	copy(header[28:], u16(0xfffe))
	copy(header[30:], u16(9))
	copy(header[32:], u16(6))
	copy(header[44:], u32(1))
	copy(header[48:], u32(8))
	copy(header[56:], u32(4096))
	copy(header[60:], u32(-2))
	copy(header[68:], u32(-2))
	for p := 76; p < 512; p += 4 {
		copy(header[p:], u32(-1))
	}
	copy(header[76:], u32(9))
	dir := make([]byte, 512)
	entry := func(dst []byte, name string, kind byte, start, size int) {
		b := unicodeBytes(name + "\x00")
		copy(dst, b)
		copy(dst[64:], u16(len(b)))
		dst[66], dst[67] = kind, 1
		copy(dst[68:], u32(-1))
		copy(dst[72:], u32(-1))
		copy(dst[76:], u32(-1))
		copy(dst[116:], u32(start))
		copy(dst[120:], u32(size))
	}
	entry(dir, "Root Entry", 5, -2, 0)
	copy(dir[76:], u32(1))
	entry(dir[128:], "Workbook", 2, 0, 4096)
	fat := make([]byte, 512)
	for p := 0; p < 512; p += 4 {
		copy(fat[p:], u32(-1))
	}
	for i := 0; i < 7; i++ {
		copy(fat[i*4:], u32(i+1))
	}
	copy(fat[28:], u32(-2))
	copy(fat[32:], u32(-2))
	copy(fat[36:], u32(-3))
	return append(append(append(header, stream...), dir...), fat...)
}
