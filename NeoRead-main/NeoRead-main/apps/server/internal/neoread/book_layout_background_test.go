package neoread

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"neoread.local/server/internal/diagnostics"
)

func TestNextBookBatchFollowsChaptersFromTheReadingPosition(t *testing.T) {
	parsed := &layoutManifest{Pages: 80, ParsedPages: []int{12, 13, 14, 15}}
	for _, c := range []struct {
		name     string
		m        *layoutManifest
		total    int
		starts   []int
		reading  int
		from, to int
		ok       bool
	}{
		{"no outline uses the page bound", nil, 80, nil, 1, 1, 30, true},
		{"chapter end bounds the batch", nil, 80, []int{1, 12, 50}, 1, 1, 11, true},
		{"short chapters share a batch", nil, 80, []int{1, 3, 5, 40}, 1, 1, 4, true},
		{"the rest of the book is one batch", nil, 53, []int{2, 45}, 45, 45, 53, true},
		{"long chapter is split", nil, 80, []int{1, 12, 50}, 20, 12, 41, true},
		{"starts at the chapter being read", nil, 80, []int{1, 12, 50}, 60, 50, 79, true},
		{"skips parsed pages and stops before them", parsed, 80, []int{1, 12, 50}, 12, 16, 45, true},
		{"wraps to unparsed pages before the reader", &layoutManifest{Pages: 10, ParsedPages: []int{6, 7, 8, 9, 10}}, 10, nil, 8, 1, 5, true},
		{"unknown page count parses a first batch", nil, 0, nil, 1, 1, 30, true},
		{"complete book", &layoutManifest{Pages: 10}, 10, nil, 1, 0, 0, false},
	} {
		from, to, ok := nextBookBatch(c.m, c.total, c.starts, c.reading)
		if from != c.from || to != c.to || ok != c.ok {
			t.Errorf("%s: got %d-%d %v, want %d-%d %v", c.name, from, to, ok, c.from, c.to, c.ok)
		}
	}
}

// fakeOutline stands in for the corpus extractor's --outline mode.
func fakeOutline(t *testing.T, outline string) {
	t.Helper()
	script := filepath.Join(t.TempDir(), "corpus.sh")
	body := `while [ $# -gt 0 ]; do case "$1" in --output) out="$2"; shift;; esac; shift; done
printf '{"totalPages":80,"pages":[],"outline":%s}' '` + outline + `' > "$out"
`
	if err := os.WriteFile(script, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_CORPUS_PROCESSOR", script)
}

func uploadBook(t *testing.T, s *Server) Document {
	t.Helper()
	w := uploadTo(t, s, "books", "book.pdf", testPDF(80))
	var d Document
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &d) != nil {
		t.Fatal(w.Body.String())
	}
	if err := s.Store.queueBookLayout(); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestBookImportParsesChaptersInTheBackgroundWithoutTranslating(t *testing.T) {
	s := testServer(t)
	s.Token = "test-secret"
	log := fakeLayout(t)
	fakeOutline(t, `[{"title":"Book","page":1,"depth":0},{"title":"One","page":1,"depth":1},{"title":"Two","page":12,"depth":1},{"title":"Three","page":50,"depth":1},{"title":"3.1","page":55,"depth":2}]`)
	d := uploadBook(t, s)
	before, _ := s.Store.processing(d.ID)
	for range 10 {
		s.runBookLayoutBatch(context.Background(), d.ID)
		jobs, err := s.Store.bookLayoutJobs()
		if err != nil {
			t.Fatal(err)
		}
		if jobs[d.ID].Status == "complete" {
			break
		}
	}
	calls, _ := os.ReadFile(log)
	if string(calls) != "1-11\n12-41\n42-49\n50-79\n80-80\n" {
		t.Fatalf("layout ran for %q", calls)
	}
	m, err := s.readLayout(d.ID)
	if err != nil || len(m.ParsedPages) != 80 || len(m.Blocks) != 80 {
		t.Fatalf("book not fully parsed: %v %v", m.ParsedPages, err)
	}
	var status string
	if err = s.Store.DB.QueryRow("SELECT status FROM book_layout_jobs WHERE document_id=?", d.ID).Scan(&status); err != nil || status != "complete" {
		t.Fatalf("job status %q %v", status, err)
	}
	after, _ := s.Store.processing(d.ID)
	if after.Phase != before.Phase || after.Status != before.Status || after.Enabled != before.Enabled || after.PagesDone != 0 {
		t.Fatalf("background parsing changed translation processing: %+v -> %+v", before, after)
	}
	for id, status := range translationStatuses(t, s, d.ID, m) {
		if status != "idle" {
			t.Fatalf("background parsing queued %s as %s", id, status)
		}
	}
}

func TestBookChaptersSkipAnUnresolvedTitleBookmark(t *testing.T) {
	s := testServer(t)
	s.Token = "test-secret"
	fakeLayout(t)
	fakeOutline(t, `[{"title":"Book","page":2,"depth":1},{"title":"One","page":2,"depth":2},{"title":"1.1","page":3,"depth":3},{"title":"Two","page":40,"depth":2}]`)
	d := uploadBook(t, s)
	if starts := s.bookChapterStarts(context.Background(), d); fmt.Sprint(starts) != "[2 40]" {
		t.Fatalf("chapter starts %v", starts)
	}
}

func TestBookLayoutProgressAndChapterRequestShareParsedPages(t *testing.T) {
	s := testServer(t)
	s.Token = "test-secret"
	log := fakeLayout(t)
	fakeOutline(t, `[]`)
	d := uploadBook(t, s)
	s.runBookLayoutBatch(context.Background(), d.ID)
	w := request(t, s, "GET", "/api/processing", nil)
	var jobs []struct {
		DocumentID string              `json:"documentId"`
		BookLayout *bookLayoutProgress `json:"bookLayout"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &jobs); err != nil || len(jobs) != 1 || jobs[0].BookLayout == nil ||
		jobs[0].BookLayout.PagesDone != 30 || jobs[0].BookLayout.PagesTotal != 80 || jobs[0].BookLayout.Status != "queued" {
		t.Fatalf("processing list: %s", w.Body.String())
	}
	if code, result := requestRangeFor(t, s, d.ID, 1, 65); code != 202 || !result.Parsing {
		t.Fatalf("chapter request: %d %+v", code, result)
	}
	p, _ := s.Store.processing(d.ID)
	if err := s.learnPDF(context.Background(), &p); err != nil {
		t.Fatal(err)
	}
	calls, _ := os.ReadFile(log)
	if string(calls) != "1-30\n31-60\n61-65\n" {
		t.Fatalf("chapter reparsed background pages: %q", calls)
	}
	s.runBookLayoutBatch(context.Background(), d.ID)
	calls, _ = os.ReadFile(log)
	if !strings.HasSuffix(string(calls), "66-80\n") {
		t.Fatalf("background parsing did not continue after the chapter: %q", calls)
	}
}

// An open reader's translation stream learns the idle state of new blocks.
func TestBackgroundParsingPublishesIdleBlocksToOpenReaders(t *testing.T) {
	s := testServer(t)
	s.Token = "test-secret"
	fakeLayout(t)
	fakeOutline(t, `[]`)
	d := uploadBook(t, s)
	ch := make(chan TranslationBlock, 64)
	s.translationMu.Lock()
	s.translationSubscribers = map[string]map[chan TranslationBlock]struct{}{d.ID: {ch: {}}}
	s.translationMu.Unlock()
	s.runBookLayoutBatch(context.Background(), d.ID)
	if len(ch) != 30 {
		t.Fatalf("published %d blocks, want the 30 new ones", len(ch))
	}
	for range 30 {
		if item := <-ch; item.Status != "idle" {
			t.Fatalf("new block published as %s", item.Status)
		}
	}
	var saved int
	if err := s.Store.DB.QueryRow("SELECT COUNT(*) FROM translations WHERE document_id=?", d.ID).Scan(&saved); err != nil || saved != 0 {
		t.Fatalf("publishing saved %d translation records: %v", saved, err)
	}
}

// A short book can finish between two polls; the list must still change.
func TestFinishedBookLayoutStaysVisibleWithItsPageCount(t *testing.T) {
	s := testServer(t)
	s.Token = "test-secret"
	fakeLayout(t)
	fakeOutline(t, `[{"title":"One","page":1,"depth":0},{"title":"Two","page":31,"depth":0},{"title":"Three","page":61,"depth":0}]`)
	d := uploadBook(t, s)
	for range 5 {
		s.runBookLayoutBatch(context.Background(), d.ID)
	}
	w := request(t, s, "GET", "/api/processing", nil)
	var jobs []struct {
		DocumentID string              `json:"documentId"`
		BookLayout *bookLayoutProgress `json:"bookLayout"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &jobs); err != nil || len(jobs) != 1 || jobs[0].BookLayout == nil ||
		*jobs[0].BookLayout != (bookLayoutProgress{Status: "complete", PagesDone: 80, PagesTotal: 80}) {
		t.Fatalf("processing list: %s", w.Body.String())
	}
}

func TestBookOutlineOutcomeIsDiagnosed(t *testing.T) {
	s := testServer(t)
	s.Token = "test-secret"
	directory := filepath.Join(s.Store.Root, "logs")
	logs, err := diagnostics.New(directory, "outline-test")
	if err != nil {
		t.Fatal(err)
	}
	s.SetDiagnostics(logs)
	fakeLayout(t)
	failing := filepath.Join(t.TempDir(), "corpus.sh")
	if err := os.WriteFile(failing, []byte("echo PRIVATE >&2; exit 3\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("NEOREAD_CORPUS_PROCESSOR", failing)
	d := uploadBook(t, s)
	if starts := s.bookChapterStarts(context.Background(), d); len(starts) != 0 {
		t.Fatalf("failed outline produced chapters %v", starts)
	}
	fakeOutline(t, `[]`)
	other := uploadTo(t, s, "books", "other.pdf", testPDF(12))
	var second Document
	if other.Code != 201 || json.Unmarshal(other.Body.Bytes(), &second) != nil {
		t.Fatal(other.Body.String())
	}
	s.bookChapterStarts(context.Background(), second)
	files, _ := filepath.Glob(filepath.Join(directory, "*.jsonl"))
	var all strings.Builder
	for _, file := range files {
		b, _ := os.ReadFile(file)
		all.Write(b)
	}
	output := all.String()
	for _, want := range []string{`"event":"book.layout.outline"`, `"outcome":"failed"`, `"reason":"exit_failed"`, `"outcome":"complete"`, `"reason":"no_outline"`, `"durationMs"`} {
		if !strings.Contains(output, want) {
			t.Errorf("missing %s in %s", want, output)
		}
	}
	if strings.Contains(output, "PRIVATE") {
		t.Fatal("outline stderr leaked into diagnostics")
	}
}

func TestBookLayoutFailureNamesTheChapter(t *testing.T) {
	s := testServer(t)
	s.Token = "test-secret"
	directory := filepath.Join(s.Store.Root, "logs")
	logs, err := diagnostics.New(directory, "layout-test")
	if err != nil {
		t.Fatal(err)
	}
	s.SetDiagnostics(logs)
	fakeLayout(t)
	fakeOutline(t, `[{"title":"PRIVATE One","page":1,"depth":0},{"title":"PRIVATE Two","page":31,"depth":0},{"title":"Three","page":61,"depth":0}]`)
	t.Setenv("FAKE_LAYOUT_FAIL_FROM", "31")
	d := uploadBook(t, s)
	s.runBookLayoutBatch(context.Background(), d.ID)
	s.runBookLayoutBatch(context.Background(), d.ID)
	files, _ := filepath.Glob(filepath.Join(directory, "*.jsonl"))
	var all strings.Builder
	for _, file := range files {
		b, _ := os.ReadFile(file)
		all.Write(b)
	}
	var failed map[string]any
	for line := range strings.SplitSeq(all.String(), "\n") {
		if strings.Contains(line, `"event":"book.layout.batch"`) && strings.Contains(line, `"outcome":"failed"`) {
			if err := json.Unmarshal([]byte(line), &failed); err != nil {
				t.Fatal(err)
			}
		}
	}
	want := map[string]any{"documentId": d.ID, "level": "error", "jobStatus": "failed", "phase": "layout",
		"reasonCode": "worker_failed", "errorCode": "process", "fromPage": 31.0, "toPage": 60.0,
		"chapter": 2.0, "chapterStartPage": 31.0, "chapters": 3.0}
	for key, value := range want {
		if failed[key] != value {
			t.Errorf("%s = %v, want %v in %v", key, failed[key], value, failed)
		}
	}
	if !strings.Contains(all.String(), `"outcome":"complete"`) {
		t.Error("successful batch left no terminal event")
	}
	if strings.Contains(all.String(), "PRIVATE") {
		t.Fatal("chapter titles leaked into diagnostics")
	}
}

func TestBookLayoutFailureWaitsForTheReader(t *testing.T) {
	s := testServer(t)
	s.Token = "test-secret"
	fakeLayout(t)
	fakeOutline(t, `[]`)
	t.Setenv("FAKE_LAYOUT_FAIL_FROM", "1")
	d := uploadBook(t, s)
	s.runBookLayoutBatch(context.Background(), d.ID)
	var status string
	_ = s.Store.DB.QueryRow("SELECT status FROM book_layout_jobs WHERE document_id=?", d.ID).Scan(&status)
	if status != "failed" {
		t.Fatalf("failed parse left job %q", status)
	}
	request(t, s, "GET", "/api/documents/"+d.ID+"/blocks", nil)
	_ = s.Store.DB.QueryRow("SELECT status FROM book_layout_jobs WHERE document_id=?", d.ID).Scan(&status)
	if status != "queued" {
		t.Fatalf("opening the book did not retry parsing: %q", status)
	}
}

func requestRangeFor(t *testing.T, s *Server, id string, from, to int) (int, translationRange) {
	t.Helper()
	body := strings.NewReader(fmt.Sprintf(`{"fromPage":%d,"toPage":%d}`, from, to))
	w := request(t, s, "POST", "/api/documents/"+id+"/translations/range", body)
	var result translationRange
	if w.Code == 202 {
		_ = json.Unmarshal(w.Body.Bytes(), &result)
	}
	return w.Code, result
}
