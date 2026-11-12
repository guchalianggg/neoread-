package neoread

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
	"neoread.local/server/internal/diagnostics"
)

func editableImport(t *testing.T, s *Server, kind string, original []byte) Document {
	t.Helper()
	w := uploadTo(t, s, "papers", "编辑样本."+kind, original)
	if w.Code != 201 {
		t.Fatalf("import: %d %s", w.Code, w.Body.String())
	}
	var d Document
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d.Type != "epub" || d.SourceFormat != kind {
		t.Fatalf("source routing: %+v", d)
	}
	w = request(t, s, "GET", "/api/documents", nil)
	if !strings.Contains(w.Body.String(), `"sourceFormat":"`+kind+`"`) {
		t.Fatal("list missing sourceFormat")
	}
	return d
}
func editableSnapshot(t *testing.T, s *Server, document string) sourceEditSnapshot {
	t.Helper()
	w := request(t, s, "GET", "/api/documents/"+document+"/source-edit", nil)
	if w.Code != 200 {
		t.Fatalf("snapshot: %d %s", w.Code, w.Body.String())
	}
	var snap sourceEditSnapshot
	if err := json.Unmarshal(w.Body.Bytes(), &snap); err != nil {
		t.Fatal(err)
	}
	if !snap.Editable || snap.Revision < 1 {
		t.Fatal(snap)
	}
	return snap
}
func editablePut(t *testing.T, s *Server, document string, revision int64, content *string, sheets []sourceEditSheet) *httptest.ResponseRecorder {
	t.Helper()
	body := map[string]any{"revision": revision}
	if content != nil {
		body["content"] = *content
	} else {
		body["sheets"] = sheets
	}
	data, _ := json.Marshal(body)
	return request(t, s, "PUT", "/api/documents/"+document+"/source-edit", bytes.NewReader(data))
}
func TestEditableMarkdownLifecycle(t *testing.T) {
	for _, kind := range []string{"md", "markdown"} {
		t.Run(kind, func(t *testing.T) {
			s := testServer(t)
			original := []byte("# OriginalWord\n\n保留原件\n")
			d := editableImport(t, s, kind, original)
			path := "/api/documents/" + d.ID
			snap := editableSnapshot(t, s, d.ID)
			if snap.Content == nil || *snap.Content != string(original) {
				t.Fatal(snap)
			}
			corpus, err := s.documentCorpus(context.Background(), d.ID, nil)
			if err != nil {
				t.Fatal(err)
			}
			text := "# SavedWord\n\n当前稿内容 中文\n"
			w := editablePut(t, s, d.ID, snap.Revision, &text, nil)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			saved := editableSnapshot(t, s, d.ID)
			if saved.Revision != 2 || *saved.Content != text {
				t.Fatal(saved)
			}
			if w = editablePut(t, s, d.ID, 1, &text, nil); w.Code != 409 {
				t.Fatal("revision", w.Code)
			}
			for _, q := range []struct {
				text string
				hit  bool
			}{{"SavedWord", true}, {"OriginalWord", false}, {"当前稿", true}} {
				w = request(t, s, "GET", path+"/search?q="+url.QueryEscape(q.text), nil)
				if w.Code != 200 || (w.Body.String() != "[]\n") != q.hit {
					t.Fatal("search", q, w.Body.String())
				}
			}
			w = request(t, s, "GET", path+"/text", nil)
			if w.Code != 200 || !strings.Contains(w.Body.String(), "SavedWord") || strings.Contains(w.Body.String(), "OriginalWord") {
				t.Fatal("text stale", w.Body.String())
			}
			w = request(t, s, "GET", "/pub/test-secret/"+d.ID+"/EPUB/chapter-1.xhtml", nil)
			if w.Code != 200 || !strings.Contains(w.Body.String(), "SavedWord") {
				t.Fatal("reading resource stale", w.Body.String())
			}
			newCorpus, err := s.documentCorpus(context.Background(), d.ID, nil)
			if err != nil || corpus.Revision == newCorpus.Revision || !strings.Contains(newCorpus.Passages[0].Text, "SavedWord") {
				t.Fatal("AI corpus stale", err, newCorpus)
			}
			file := request(t, s, "GET", path+"/source-edit/file", nil)
			if file.Code != 200 || file.Body.String() != text {
				t.Fatal("export", file.Code, file.Body.String())
			}
			// A new Store/server sees the committed version, not an in-memory cache.
			root := s.Store.Root
			s.Close()
			_ = s.Store.DB.Close()
			store, err := OpenStore(root)
			if err != nil {
				t.Fatal(err)
			}
			defer store.DB.Close()
			s = NewServer(store, "test-secret", "")
			defer s.Close()
			if reopened := editableSnapshot(t, s, d.ID); reopened.Revision != 2 || *reopened.Content != text {
				t.Fatal(reopened)
			}
			if w = uploadTo(t, s, "papers", "重导入."+kind, original); w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			if *editableSnapshot(t, s, d.ID).Content != text {
				t.Fatal("reimport overwrote edits")
			}
			if w = request(t, s, "POST", path+"/trash", nil); w.Code != 200 {
				t.Fatal(w.Code)
			}
			if w = request(t, s, "GET", path+"/source-edit", nil); w.Code != 404 {
				t.Fatal(w.Code)
			}
			if w = request(t, s, "POST", path+"/restore", nil); w.Code != 200 {
				t.Fatal(w.Code)
			}
			if *editableSnapshot(t, s, d.ID).Content != text {
				t.Fatal("trash lost edits")
			}
			attachments := attachmentList(t, s, d.ID)
			w = request(t, s, "GET", path+"/attachments/"+attachments[0].ID+"/file", nil)
			if !bytes.Equal(w.Body.Bytes(), original) {
				t.Fatal("original changed")
			}
			empty := ""
			if w = editablePut(t, s, d.ID, 2, &empty, nil); w.Code != 200 {
				t.Fatal("clear", w.Code, w.Body.String())
			}
			if current := editableSnapshot(t, s, d.ID); current.Content == nil || *current.Content != "" {
				t.Fatal("empty lost")
			}
			if w = request(t, s, "GET", path+"/source-edit/file", nil); w.Code != 200 || w.Body.Len() != 0 {
				t.Fatal("empty export")
			}
			if w = request(t, s, "POST", path+"/reparse", nil); w.Code != 409 {
				t.Fatal("unsafe reparse", w.Code)
			}
			if w = request(t, s, "DELETE", path, nil); w.Code != 204 {
				t.Fatal(w.Code, w.Body.String())
			}
			if _, err = os.Stat(filepath.Join(root, "cache", d.ID)); !os.IsNotExist(err) {
				t.Fatal("purge cache", err)
			}
			if entries, e := os.ReadDir(filepath.Join(root, "attachments")); e != nil || len(entries) != 0 {
				t.Fatal("purge attachment", e, len(entries))
			}
			var count int
			_ = store.DB.QueryRow("SELECT count(*) FROM source_edits WHERE document_id=?", d.ID).Scan(&count)
			if count != 0 {
				t.Fatal("purge row")
			}
		})
	}
}
func TestEditableSheetsLifecycle(t *testing.T) {
	for _, kind := range []string{"xlsx", "xls"} {
		t.Run(kind, func(t *testing.T) {
			s := testServer(t)
			original := sourceTestBinaryXLS()
			if kind == "xlsx" {
				original = sourceTestXLSX(t, "normal")
			}
			d := editableImport(t, s, kind, original)
			snap := editableSnapshot(t, s, d.ID)
			if len(snap.Sheets) != 2 || snap.Content != nil {
				t.Fatal(snap)
			}
			if kind == "xlsx" && snap.Sheets[0].Rows[0][1] != "12.50" {
				t.Fatal("numeric display", snap.Sheets)
			}
			sheets := []sourceEditSheet{{Name: "当前表", Rows: [][]string{{"CurrentSheet", "=1+1", "中文\n第二行"}, {"12.50", ""}}}, {Name: "Sheet1", Rows: [][]string{}}}
			w := editablePut(t, s, d.ID, 1, nil, sheets)
			if w.Code != 200 {
				t.Fatal(w.Code, w.Body.String())
			}
			w = request(t, s, "GET", "/api/documents/"+d.ID+"/source-edit/file", nil)
			if w.Code != 200 || !strings.HasSuffix(editableSnapshot(t, s, d.ID).Filename, ".xlsx") {
				t.Fatal(w.Code)
			}
			book, err := excelize.OpenReader(bytes.NewReader(w.Body.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			defer book.Close()
			if value, e := book.GetCellValue("当前表", "B1"); e != nil || value != "=1+1" {
				t.Fatal(value, e)
			}
			if formula, e := book.GetCellFormula("当前表", "B1"); e != nil || formula != "" {
				t.Fatal("formula executed", formula, e)
			}
			if value, e := book.GetCellValue("当前表", "A2"); e != nil || value != "12.50" {
				t.Fatal(value, e)
			}
			before := append([]byte{}, w.Body.Bytes()...)
			bad := []sourceEditSheet{{Name: "dup", Rows: [][]string{}}, {Name: "DUP", Rows: [][]string{}}}
			if w = editablePut(t, s, d.ID, 2, nil, bad); w.Code != 400 {
				t.Fatal(w.Code, w.Body.String())
			}
			if w = request(t, s, "GET", "/api/documents/"+d.ID+"/source-edit/file", nil); !bytes.Equal(before, w.Body.Bytes()) {
				t.Fatal("invalid save changed file")
			}
			if editableSnapshot(t, s, d.ID).Revision != 2 {
				t.Fatal("invalid save incremented")
			}
			w = request(t, s, "GET", "/api/documents/"+d.ID+"/search?q=CurrentSheet", nil)
			if w.Code != 200 || w.Body.String() == "[]\n" {
				t.Fatal("sheet search stale", w.Body.String())
			}
			// Reopen the file/DB and ensure the logical cells also persist exactly.
			store, err := OpenStore(s.Store.Root)
			if err != nil {
				t.Fatal(err)
			}
			defer store.DB.Close()
			other := NewServer(store, "test-secret", "")
			defer other.Close()
			if got := editableSnapshot(t, other, d.ID); got.Revision != 2 || got.Sheets[0].Rows[0][1] != "=1+1" {
				t.Fatal(got)
			}
			a := attachmentList(t, s, d.ID)[0]
			w = request(t, s, "GET", "/api/documents/"+d.ID+"/attachments/"+a.ID+"/file", nil)
			if !bytes.Equal(original, w.Body.Bytes()) {
				t.Fatal("Excel original modified")
			}
			if w = editablePut(t, s, d.ID, 2, nil, []sourceEditSheet{{Name: "空表", Rows: [][]string{}}}); w.Code != 200 {
				t.Fatal("empty sheet", w.Code, w.Body.String())
			}
		})
	}
}
func TestEditableRollbackLimitsAndBoundaries(t *testing.T) {
	s := testServer(t)
	d := editableImport(t, s, "md", []byte("# RollbackOriginal"))
	path := "/api/documents/" + d.ID + "/source-edit"
	_ = editableSnapshot(t, s, d.ID)
	beforeFile, _ := os.ReadFile(s.Store.File(d))
	for _, body := range []string{`{}`, `null`, `{"revision":1}`, `{"revision":1,"content":null}`, `{"revision":1,"content":"x","unknown":1}`, `{"revision":1,"content":"x"} {}`, `{"revision":1,"content":"\u0000"}`, `{"revision":1,"content":"%PDF-fake"}`} {
		w := request(t, s, "PUT", path, strings.NewReader(body))
		if w.Code != 400 {
			t.Fatalf("%s => %d %s", body, w.Code, w.Body.String())
		}
	}
	large := strings.Repeat("x", sourceEditTextLimit+1)
	if w := editablePut(t, s, d.ID, 1, &large, nil); w.Code != 413 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request(t, s, "PUT", path, strings.NewReader(strings.Repeat("x", sourceEditRequestLimit+1))); w.Code != 413 {
		t.Fatal(w.Code)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest("PUT", "http://127.0.0.1:17840"+path, strings.NewReader(`{"revision":1,"content":"cancel"}`)).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer test-secret")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 408 {
		t.Fatal("cancel", w.Code)
	}
	// Force a late SQLite failure, after candidate files were completely built.
	if _, err := s.Store.DB.Exec(`CREATE TRIGGER source_edit_fail BEFORE UPDATE ON source_edits BEGIN SELECT RAISE(ABORT,'test'); END`); err != nil {
		t.Fatal(err)
	}
	text := "# RejectedWord"
	if w = editablePut(t, s, d.ID, 1, &text, nil); w.Code != 500 {
		t.Fatal(w.Code, w.Body.String())
	}
	_, _ = s.Store.DB.Exec("DROP TRIGGER source_edit_fail")
	if snap := editableSnapshot(t, s, d.ID); snap.Revision != 1 || !strings.Contains(*snap.Content, "RollbackOriginal") {
		t.Fatal(snap)
	}
	if data, _ := os.ReadFile(s.Store.File(d)); !bytes.Equal(beforeFile, data) {
		t.Fatal("rollback changed reading")
	}
	entries, err := os.ReadDir(filepath.Join(s.Store.Root, "cache", d.ID, "source-edits"))
	if err != nil || len(entries) != 1 {
		t.Fatal("orphaned failed generation", len(entries), err)
	}
	for _, kind := range []string{"epub", "pdf"} {
		data := bookEPUB(t)
		if kind == "pdf" {
			data = []byte("%PDF-1.7 test")
		}
		w = upload(t, s, "ordinary."+kind, data)
		if w.Code != 201 {
			t.Fatal(w.Code, w.Body.String())
		}
		var other Document
		_ = json.Unmarshal(w.Body.Bytes(), &other)
		for _, suffix := range []string{"/source-edit", "/source-edit/file"} {
			if w = request(t, s, "GET", "/api/documents/"+other.ID+suffix, nil); w.Code != 404 {
				t.Fatal("ordinary admitted", w.Code)
			}
		}
		if w = editablePut(t, s, other.ID, 1, &text, nil); w.Code != 404 {
			t.Fatal(w.Code)
		}
	}
	// Existing notes and transcripts must never be deleted to make editing easy.
	annotation := `{"kind":"highlight","location":{"type":"epub","href":"EPUB/chapter-1.xhtml"},"quote":"Original","color":"yellow"}`
	w = request(t, s, "POST", "/api/documents/"+d.ID+"/annotations", strings.NewReader(annotation))
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = editablePut(t, s, d.ID, 1, &text, nil); w.Code != 409 || !strings.Contains(w.Body.String(), "批注") {
		t.Fatal(w.Code, w.Body.String())
	}
	var count int
	_ = s.Store.DB.QueryRow("SELECT count(*) FROM annotations WHERE document_id=?", d.ID).Scan(&count)
	if count != 1 {
		t.Fatal("annotation lost")
	}
}
func TestEditableSheetLimits(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name   string
		sheets []sourceEditSheet
		code   string
	}{
		{"zero", nil, "validation"}, {"many", make([]sourceEditSheet, 65), "validation"},
		{"bad-name", []sourceEditSheet{{Name: "bad/name"}}, "validation"},
		{"rows", []sourceEditSheet{{Name: "x", Rows: make([][]string, 10001)}}, "limit"},
		{"columns", []sourceEditSheet{{Name: "x", Rows: [][]string{make([]string, 257)}}}, "limit"},
		{"cell", []sourceEditSheet{{Name: "x", Rows: [][]string{{strings.Repeat("字", 32768)}}}}, "limit"},
		{"control", []sourceEditSheet{{Name: "x", Rows: [][]string{{"\x00"}}}}, "validation"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if e := validateSourceSnapshot(ctx, sourceEditSnapshot{Kind: "xlsx", Sheets: tc.sheets}); sourceReason(e) != tc.code {
				t.Fatal(e)
			}
		})
	}
	rows := make([][]string, 5000)
	for i := range rows {
		rows[i] = make([]string, 30)
	}
	if e := validateSourceSnapshot(ctx, sourceEditSnapshot{Kind: "xlsx", Sheets: []sourceEditSheet{{Name: "x", Rows: rows}, {Name: "y", Rows: rows}}}); sourceReason(e) != "limit" {
		t.Fatal("cross-sheet", e)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if e := validateSourceSnapshot(cancelled, sourceEditSnapshot{Kind: "xlsx"}); e != context.Canceled {
		t.Fatal(e)
	}
}
func TestEditableConcurrentRevision(t *testing.T) {
	s := testServer(t)
	d := editableImport(t, s, "md", []byte("# Start"))
	_ = editableSnapshot(t, s, d.ID)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			text := fmt.Sprintf("# Save%d", i)
			codes <- editablePut(t, s, d.ID, 1, &text, nil).Code
		}(i)
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for code := range codes {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatal(counts)
	}
}
func TestEditableDiagnostics(t *testing.T) {
	s := testServer(t)
	dir := t.TempDir()
	logs, err := diagnostics.New(dir, "editable-test")
	if err != nil {
		t.Fatal(err)
	}
	s.SetDiagnostics(logs)
	d := editableImport(t, s, "md", []byte("# PRIVATE_EDIT_BODY"))
	_ = editableSnapshot(t, s, d.ID)
	text := "# PRIVATE_SAVED_BODY"
	w := editablePut(t, s, d.ID, 1, &text, nil)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	w = editablePut(t, s, d.ID, 1, &text, nil)
	if w.Code != 409 {
		t.Fatal(w.Code)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	var all []byte
	for _, file := range files {
		data, _ := os.ReadFile(file)
		all = append(all, data...)
	}
	for _, want := range []string{"document.source_edit.start", "document.source_edit.finish", "conflict", "durationMs"} {
		if !bytes.Contains(all, []byte(want)) {
			t.Fatal("missing event", want)
		}
	}
	if bytes.Contains(all, []byte("PRIVATE_EDIT_BODY")) || bytes.Contains(all, []byte("PRIVATE_SAVED_BODY")) || bytes.Contains(all, []byte(s.Store.Root)) {
		t.Fatal("private source leaked")
	}
}

func wordTestDOCX(t *testing.T) []byte {
	t.Helper()
	if _, err := exec.LookPath("pandoc"); err != nil {
		t.Skip("pandoc not installed")
	}
	path := filepath.Join(t.TempDir(), "sample.docx")
	if err := markdownToDOCX(context.Background(), "# WordHeading\n\nWordOriginal 正文\n\n- One\n- Two\n\n| A | B |\n|---|---|\n| 12 | 中文 |\n", path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func TestWordEditableDOCX(t *testing.T) {
	s := testServer(t)
	original := wordTestDOCX(t)
	d := editableImport(t, s, "docx", original)
	snap := editableSnapshot(t, s, d.ID)
	if snap.Content == nil || !strings.Contains(*snap.Content, "WordOriginal") || !strings.Contains(*snap.Content, "WordHeading") || !strings.Contains(*snap.Content, "|") {
		t.Fatal(snap)
	}
	text := "# WordSaved\n\n富文本编辑后的正文\n\n- 项目\n\n| 列1 | 列2 |\n|---|---|\n| a | b |\n"
	w := editablePut(t, s, d.ID, 1, &text, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(t, s, "GET", "/api/documents/"+d.ID+"/source-edit/file", nil)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	path := filepath.Join(t.TempDir(), "export.docx")
	_ = os.WriteFile(path, w.Body.Bytes(), 0600)
	if err := validateDOCX(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	md, err := wordMarkdown(context.Background(), path, "docx")
	if err != nil || !strings.Contains(md, "WordSaved") || !strings.Contains(md, "富文本") {
		t.Fatal(md, err)
	}
	otherStore, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer otherStore.DB.Close()
	other := NewServer(otherStore, "test-secret", "")
	defer other.Close()
	if got := editableSnapshot(t, other, d.ID); got.Revision != 2 || !strings.Contains(*got.Content, "WordSaved") {
		t.Fatal(got)
	}
	att := attachmentList(t, s, d.ID)[0]
	w = request(t, s, "GET", "/api/documents/"+d.ID+"/attachments/"+att.ID+"/file", nil)
	if !bytes.Equal(original, w.Body.Bytes()) {
		t.Fatal("Word original modified")
	}
	empty := ""
	if w = editablePut(t, s, d.ID, 2, &empty, nil); w.Code != 200 {
		t.Fatal("empty Word", w.Code, w.Body.String())
	}
}
func TestWordUnsafeResourcesAndRejections(t *testing.T) {
	_ = wordTestDOCX(t)
	work := t.TempDir()
	text := `# Safe` + "\n\n" + `![x](file:///NEVER_READ_PRIVATE.png) ![web](https://example.invalid/NEVER_FETCH.png) [bad](javascript:alert(1)) <script>PRIVATE_RAW_HTML</script>`
	out := filepath.Join(work, "safe.docx")
	if err := markdownToDOCX(context.Background(), text, out); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(out)
	files := sourceTestZIP(t, data)
	for name, content := range files {
		if strings.Contains(content, "NEVER_READ_PRIVATE") || strings.Contains(content, "NEVER_FETCH") || strings.Contains(content, "javascript:") || strings.Contains(content, "PRIVATE_RAW_HTML") {
			t.Fatal("unsafe survived", name)
		}
	}
	for _, kind := range []string{"doc", "docx"} {
		path := filepath.Join(work, "fake."+kind)
		_ = os.WriteFile(path, []byte("just renamed text"), 0600)
		if _, err := wordMarkdown(context.Background(), path, kind); sourceReason(err) != "format" {
			t.Fatal(kind, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := wordMarkdown(ctx, out, "docx"); err != context.Canceled {
		t.Fatal("cancel", err)
	}
}

// Explicitly opt in: generates ONLY synthetic test material in t.TempDir and
// exercises real Office COM. It never opens or enumerates the user's documents.
func TestWordCOMLegacyDOC(t *testing.T) {
	if runtime.GOOS != "windows" || os.Getenv("NEOREAD_TEST_WORD_COM") != "1" {
		t.Skip("set NEOREAD_TEST_WORD_COM=1 for synthetic Office regression")
	}
	originalDOCX := wordTestDOCX(t)
	work := t.TempDir()
	input := filepath.Join(work, "fixture.docx")
	doc := filepath.Join(work, "fixture.doc")
	_ = os.WriteFile(input, originalDOCX, 0600)
	// Reuse the same ownership, macro, read-only, cleanup and timeout logic;
	// only the save format changes for this synthetic legacy fixture.
	script := strings.Replace(string(sourceWordScript), "$document.SaveAs2($Destination, 16,", "$document.SaveAs2($Destination, 0,", 1)
	scriptPath := filepath.Join(work, "fixture.ps1")
	_ = os.WriteFile(scriptPath, append([]byte{0xef, 0xbb, 0xbf}, []byte(script)...), 0600)
	pidFile := filepath.Join(work, "owned.json")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Source", input, "-Destination", doc, "-PidFile", pidFile)
	cmd.Dir = work
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	err := cmd.Run()
	cleanup := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Mode", "cleanup", "-PidFile", pidFile)
	cleanup.Stdout, cleanup.Stderr = io.Discard, io.Discard
	_ = cleanup.Run()
	if err != nil {
		t.Fatal("synthetic DOC creation", err)
	}
	original, err := os.ReadFile(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err = validateDOC(context.Background(), doc); err != nil {
		t.Fatal(err)
	}
	s := testServer(t)
	d := editableImport(t, s, "doc", original)
	snap := editableSnapshot(t, s, d.ID)
	if !strings.Contains(*snap.Content, "WordOriginal") || !strings.HasSuffix(snap.Filename, ".docx") {
		t.Fatal(snap)
	}
	text := "# LegacySaved\n\n修改旧 DOC 的应用内副本"
	w := editablePut(t, s, d.ID, 1, &text, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(t, s, "GET", "/api/documents/"+d.ID+"/source-edit/file", nil)
	if w.Code != 200 || !bytes.HasPrefix(w.Body.Bytes(), []byte("PK")) {
		t.Fatal("DOC must export true DOCX", w.Code)
	}
	// Real Word opens the actual edited download, not just the input fixture.
	export := filepath.Join(work, "edited.docx")
	if err = os.WriteFile(export, w.Body.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	open := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Source", export, "-Destination", filepath.Join(work, "reopened.doc"), "-PidFile", pidFile)
	open.Dir = work
	open.Stdout, open.Stderr = io.Discard, io.Discard
	if err = open.Run(); err != nil {
		_ = cleanup.Run()
		t.Fatal("Word cannot open edited DOCX", err)
	}
	_ = exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Mode", "cleanup", "-PidFile", pidFile).Run()
	// Cancel only after the private PID is recorded, while conversion is live.
	cancelWork := t.TempDir()
	cancelCtx, stop := context.WithCancel(context.Background())
	defer stop()
	done := make(chan error, 1)
	go func() {
		done <- convertLegacyDOC(cancelCtx, doc, filepath.Join(cancelWork, "cancelled.docx"), cancelWork)
	}()
	deadline := time.After(25 * time.Second)
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case err := <-done:
			t.Fatalf("conversion finished before cancellation: %v", err)
		case <-deadline:
			stop()
			<-done
			t.Fatal("private Word PID was not recorded")
		case <-tick.C:
			if data, e := os.ReadFile(filepath.Join(cancelWork, "word-process.json")); e == nil && len(data) > 10 {
				stop()
				if err := <-done; err != context.Canceled {
					t.Fatal("COM cancellation", err)
				}
				return
			}
		}
	}
}

func TestEditableStrictRequestsAndPositionBoundary(t *testing.T) {
	s := testServer(t)
	d := editableImport(t, s, "md", []byte("# Strict"))
	path := "/api/documents/" + d.ID
	_ = editableSnapshot(t, s, d.ID)
	for _, body := range []string{
		`{"revision":1,"content":"x","sheets":[]}`,
		`{"revision":1,"content":"x","content":"y"}`,
		`{"revision":1,"content":"\ud800"}`,
		`{"revision":1,"content":"\udc00"}`,
		`{"revision":1,"content":"\ud800\u0041"}`,
		`{"revision":1,"content":"x","sheets":null}`,
	} {
		if w := request(t, s, "PUT", path+"/source-edit", strings.NewReader(body)); w.Code != 400 {
			t.Fatal(body, w.Code, w.Body.String())
		}
	}
	for _, good := range []string{`{"content":"\ud83d\ude00"}`, `{"content":"\\ud800"}`, `{"content":""}`} {
		if !validSourceEditJSON([]byte(good)) {
			t.Fatal("valid Unicode rejected", good)
		}
	}
	// Conversation rows and document notes survive the generation switch.
	_, err := s.Store.DB.Exec("INSERT INTO messages(id,document_id,body,created_at) VALUES('retained-message',?,?,'now')", d.ID, `{"role":"user","content":"history"}`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Store.DB.Exec("INSERT INTO document_notes(document_id,body,updated_at) VALUES(?,'retained note','now')", d.ID)
	if err != nil {
		t.Fatal(err)
	}
	text := "# Edited"
	if w := editablePut(t, s, d.ID, 1, &text, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var count int
	_ = s.Store.DB.QueryRow("SELECT count(*) FROM messages WHERE document_id=?", d.ID).Scan(&count)
	if count != 1 {
		t.Fatal("history deleted")
	}
	var note string
	_ = s.Store.DB.QueryRow("SELECT body FROM document_notes WHERE document_id=?", d.ID).Scan(&note)
	if note != "retained note" {
		t.Fatal("document note deleted")
	}
	for _, tc := range []struct{ method, suffix, body string }{
		{"POST", "/annotations", `{"kind":"highlight","location":{"type":"epub","href":"EPUB/chapter-1.xhtml"}}`},
		{"PATCH", "", `{"progress":{"type":"epub","href":"EPUB/chapter-1.xhtml"}}`},
		{"PUT", "/navigation", `{"revision":0,"entries":{}}`},
	} {
		if w := request(t, s, tc.method, path+tc.suffix, strings.NewReader(tc.body)); w.Code != 409 {
			t.Fatal("stale location accepted", tc, w.Code, w.Body.String())
		}
	}
	x := editableImport(t, s, "xlsx", sourceTestXLSX(t, "normal"))
	_ = editableSnapshot(t, s, x.ID)
	for _, body := range []string{
		`{"revision":1,"sheets":[{"name":"x","rows":[[null]]}]}`,
		`{"revision":1,"sheets":[{"name":"x","rows":[null]}]}`,
		`{"revision":1,"sheets":[{"name":"x"}]}`,
		`{"revision":1,"sheets":[{"name":"x","rows":[[1]]}]}`,
	} {
		if w := request(t, s, "PUT", "/api/documents/"+x.ID+"/source-edit", strings.NewReader(body)); w.Code != 400 {
			t.Fatal(body, w.Code, w.Body.String())
		}
	}
}

func TestEditableHTTPRoundTrip(t *testing.T) {
	s := testServer(t)
	d := editableImport(t, s, "md", []byte("# ActualHTTP"))
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	for _, tc := range []struct {
		method, body string
		revision     int64
	}{{"GET", "", 1}, {"PUT", `{"revision":1,"content":"# ViaHTTP"}`, 2}, {"GET", "", 2}} {
		r, err := http.NewRequest(tc.method, server.URL+"/api/documents/"+d.ID+"/source-edit", strings.NewReader(tc.body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Authorization", "Bearer test-secret")
		r.Header.Set("Content-Type", "application/json")
		response, err := server.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		var snap sourceEditSnapshot
		err = json.NewDecoder(response.Body).Decode(&snap)
		_ = response.Body.Close()
		if err != nil || response.StatusCode != 200 || snap.Revision != tc.revision {
			t.Fatal(response.StatusCode, snap, err)
		}
	}
}
