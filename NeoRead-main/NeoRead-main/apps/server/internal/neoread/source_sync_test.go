package neoread

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"neoread.local/server/internal/diagnostics"
)

func sourceSyncRequest(t *testing.T, s *Server, documentID string, data io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:17840/api/documents/"+documentID+"/source-sync", data)
	r.Header.Set("Authorization", "Bearer test-secret")
	r.Header.Set("Content-Type", "application/octet-stream")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

func expectSourceSyncRevision(t *testing.T, w *httptest.ResponseRecorder, revision int64) {
	t.Helper()
	if revision == 0 {
		if w.Code != http.StatusNoContent || w.Body.Len() != 0 {
			t.Fatalf("expected empty 204, got %d %s", w.Code, w.Body)
		}
		return
	}
	var response map[string]int64
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &response) != nil || len(response) != 1 || response["revision"] != revision {
		t.Fatalf("expected revision %d, got %d %s", revision, w.Code, w.Body)
	}
}

func expectSourceSyncConflict(t *testing.T, w *httptest.ResponseRecorder, code string) {
	t.Helper()
	var response map[string]string
	if w.Code != http.StatusConflict || json.Unmarshal(w.Body.Bytes(), &response) != nil || response["error"] == "" || response["code"] != code {
		t.Fatalf("expected 409 %s, got %d %s", code, w.Code, w.Body)
	}
}

func TestSourceSyncMarkdownLifecycle(t *testing.T) {
	for _, kind := range []string{"md", "markdown"} {
		t.Run(kind, func(t *testing.T) {
			s := testServer(t)
			original := "\ufeff# Imported\n"
			d := editableImport(t, s, kind, []byte(original))
			path := "/api/documents/" + d.ID
			syncText := func(text string) *httptest.ResponseRecorder {
				return sourceSyncRequest(t, s, d.ID, strings.NewReader(text))
			}
			if w := request(t, s, "PUT", path+"/note", strings.NewReader(`{"body":"keep this note"}`)); w.Code != 200 {
				t.Fatal(w.Code, w.Body)
			}
			expectSourceSyncRevision(t, syncText(original), 0)
			if kind == "markdown" { // Also cover an editor initialized but never saved.
				if snap := editableSnapshot(t, s, d.ID); snap.Revision != 1 {
					t.Fatal(snap.Revision)
				}
			}
			oldCorpus, err := s.documentCorpus(context.Background(), d.ID, nil)
			if err != nil {
				t.Fatal(err)
			}
			first, second := "# FirstSync\r\n", "\ufeff# SecondSync\n"
			expectSourceSyncRevision(t, syncText(first), 2)
			expectSourceSyncRevision(t, syncText(first), 0)
			expectSourceSyncRevision(t, syncText(second), 3)
			if snap := editableSnapshot(t, s, d.ID); snap.Revision != 3 || snap.Content == nil || *snap.Content != strings.TrimPrefix(second, "\ufeff") {
				t.Fatal(snap)
			}
			if w := request(t, s, "GET", path+"/text", nil); w.Code != 200 || !strings.Contains(w.Body.String(), "SecondSync") || strings.Contains(w.Body.String(), "FirstSync") {
				t.Fatal(w.Code, w.Body)
			}
			if w := request(t, s, "GET", path+"/search?q=SecondSync", nil); w.Code != 200 || !strings.Contains(w.Body.String(), "SecondSync") {
				t.Fatal(w.Code, w.Body)
			}
			if corpus, err := s.documentCorpus(context.Background(), d.ID, nil); err != nil || corpus.Revision == oldCorpus.Revision || len(corpus.Passages) == 0 || !strings.Contains(corpus.Passages[0].Text, "SecondSync") {
				t.Fatal("stale corpus", err)
			}
			if w := request(t, s, "GET", path+"/note", nil); w.Code != 200 || !strings.Contains(w.Body.String(), "keep this note") {
				t.Fatal(w.Code, w.Body)
			}
			originalAttachment := attachmentList(t, s, d.ID)[0]
			if w := request(t, s, "GET", path+"/attachments/"+originalAttachment.ID+"/file", nil); w.Code != 200 || w.Body.String() != original {
				t.Fatal("original attachment changed", w.Code)
			}
			store, err := OpenStore(s.Store.Root)
			if err != nil {
				t.Fatal(err)
			}
			defer store.DB.Close()
			reopened := NewServer(store, "test-secret", "")
			defer reopened.Close()
			expectSourceSyncRevision(t, sourceSyncRequest(t, reopened, d.ID, strings.NewReader(second)), 0)
			// Different raw bytes still publish, even when converted text is identical.
			expectSourceSyncRevision(t, syncText(strings.TrimPrefix(second, "\ufeff")), 4)
			if w := request(t, s, "DELETE", path, nil); w.Code != 204 {
				t.Fatal(w.Code, w.Body)
			}
			var count int
			if err := s.Store.DB.QueryRow("SELECT count(*) FROM source_syncs WHERE document_id=?", d.ID).Scan(&count); err != nil || count != 0 {
				t.Fatal("sync state survived purge", count, err)
			}
		})
	}
}

func TestSourceSyncReaderSaveWins(t *testing.T) {
	for _, syncFirst := range []bool{false, true} {
		s := testServer(t)
		external := "# Initial\n"
		d := editableImport(t, s, "md", []byte(external))
		revision := int64(1)
		if syncFirst {
			external = "# Synced\n"
			expectSourceSyncRevision(t, sourceSyncRequest(t, s, d.ID, strings.NewReader(external)), 2)
			revision = 2
		}
		local := "# Local edit\n"
		if w := editablePut(t, s, d.ID, revision, &local, nil); w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
		for _, text := range []string{external, "# Changed externally\n", local} {
			expectSourceSyncConflict(t, sourceSyncRequest(t, s, d.ID, strings.NewReader(text)), "conflict")
		}
		if snap := editableSnapshot(t, s, d.ID); snap.Revision != revision+1 || snap.Content == nil || *snap.Content != local {
			t.Fatal("local save overwritten", snap)
		}
	}
}

func TestSourceSyncRejectionsAndAtomicRollback(t *testing.T) {
	s := testServer(t)
	d := editableImport(t, s, "md", []byte("# Import\n"))
	path := "/api/documents/" + d.ID
	original := "# FirstSync\n"
	next := "# PRIVATE_SOURCE_SYNC_BODY\n"
	syncText := func(text string) *httptest.ResponseRecorder {
		return sourceSyncRequest(t, s, d.ID, strings.NewReader(text))
	}
	expectSourceSyncRevision(t, syncText(original), 2)
	oldPath := s.Store.File(d)
	logDir := t.TempDir()
	logs, err := diagnostics.New(logDir, "source-sync-test")
	if err != nil {
		t.Fatal(err)
	}
	s.SetDiagnostics(logs)
	for _, text := range []string{"\x00invalid", "\xff", "%PDF-invalid"} {
		if w := syncText(text); w.Code != 400 {
			t.Fatal(w.Code, w.Body)
		}
	}
	// Hide Content-Length to exercise the streaming request limit.
	if w := sourceSyncRequest(t, s, d.ID, io.LimitReader(strings.NewReader(strings.Repeat("x", markdownSourceLimit+1)), markdownSourceLimit+1)); w.Code != 413 {
		t.Fatal(w.Code, w.Body)
	}
	if w := request(t, s, "POST", path+"/source-sync", strings.NewReader(`{"path":"unused.md"}`)); w.Code != 415 {
		t.Fatal(w.Code, w.Body)
	}
	unauthenticated := httptest.NewRequest("POST", "http://127.0.0.1:17840"+path+"/source-sync", strings.NewReader(next))
	unauthenticated.Header.Set("Content-Type", "application/octet-stream")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, unauthenticated)
	if w.Code != 401 {
		t.Fatal(w.Code, w.Body)
	}
	finish, err := s.beginDocumentReparse(d)
	if err != nil {
		t.Fatal(err)
	}
	busy := syncText(next)
	finish()
	expectSourceSyncConflict(t, busy, "busy")
	if _, err := s.Store.DB.Exec("CREATE TRIGGER test_sync_failure BEFORE INSERT ON document_corpus_jobs BEGIN SELECT RAISE(ABORT,'test'); END"); err != nil {
		t.Fatal(err)
	}
	if w := syncText(next); w.Code != 500 {
		t.Fatal(w.Code, w.Body)
	}
	if _, err := s.Store.DB.Exec("DROP TRIGGER test_sync_failure"); err != nil {
		t.Fatal(err)
	}
	if snap := editableSnapshot(t, s, d.ID); snap.Revision != 2 || snap.Content == nil || *snap.Content != original || s.Store.File(d) != oldPath {
		t.Fatal("failed sync changed current generation", snap)
	}
	expectSourceSyncRevision(t, syncText(original), 0)
	published := syncText(next)
	expectSourceSyncRevision(t, published, 3)
	files, err := filepath.Glob(filepath.Join(logDir, "*.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		output.Write(data)
	}
	for w, fields := range map[*httptest.ResponseRecorder][]string{published: {`"outcome":"complete"`, `"phase":"publish"`, `"revision":3`}, busy: {`"phase":"eligibility"`, `"reasonCode":"busy"`}} {
		found := false
		for line := range strings.SplitSeq(output.String(), "\n") {
			if !strings.Contains(line, "document.source_sync.finish") || !strings.Contains(line, w.Header().Get("X-NeoRead-Request-ID")) {
				continue
			}
			found = true
			for _, field := range fields {
				if !strings.Contains(line, field) {
					t.Fatal("missing diagnostic field", field)
				}
			}
		}
		if !found {
			t.Fatal("missing sync diagnostic")
		}
	}
	if strings.Contains(output.String(), "PRIVATE_SOURCE_SYNC_BODY") || strings.Contains(output.String(), filepath.Base(filepath.Dir(s.Store.Root))) {
		t.Fatal("private sync data logged")
	}
}

func TestSourceSyncAnchoredAndLifecycle(t *testing.T) {
	s := testServer(t)
	original := []byte("# Initial\n")
	d := editableImport(t, s, "md", original)
	path := "/api/documents/" + d.ID
	if _, err := s.Store.DB.Exec(`UPDATE documents SET progress='{"href":"chapter-1.xhtml"}',percentage=12 WHERE id=?`, d.ID); err != nil {
		t.Fatal(err)
	}
	changed := "# Changed\n"
	expectSourceSyncConflict(t, sourceSyncRequest(t, s, d.ID, strings.NewReader(changed)), "anchored")
	if current, err := s.Store.Document(d.ID); err != nil || current.Percentage != 12 || !strings.Contains(string(current.Progress), "chapter-1.xhtml") {
		t.Fatal("reading progress changed", err)
	}
	expectSourceSyncRevision(t, sourceSyncRequest(t, s, d.ID, bytes.NewReader(original)), 0)
	if w := request(t, s, "POST", path+"/trash", nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	if w := sourceSyncRequest(t, s, d.ID, strings.NewReader(changed)); w.Code != 404 {
		t.Fatal(w.Code, w.Body)
	}
	if w := request(t, s, "POST", path+"/restore", nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	body := io.MultiReader(sourceSyncReadFunc(func([]byte) (int, error) {
		if w := request(t, s, "DELETE", path, nil); w.Code != 204 {
			t.Fatal(w.Code, w.Body)
		}
		if imported := editableImport(t, s, "md", original); imported.ID != d.ID || imported.CreatedAt == d.CreatedAt {
			t.Fatal("expected a new incarnation of the same ID")
		}
		return 0, io.EOF
	}), strings.NewReader(changed))
	if w := sourceSyncRequest(t, s, d.ID, body); w.Code != 404 {
		t.Fatal("stale upload accepted", w.Code, w.Body)
	}
	if snap := editableSnapshot(t, s, d.ID); snap.Revision != 1 || snap.Content == nil || *snap.Content != string(original) {
		t.Fatal("reimport overwritten", snap)
	}
	if w := sourceSyncRequest(t, s, editableImport(t, s, "xlsx", sourceTestXLSX(t, "")).ID, strings.NewReader(changed)); w.Code != 415 {
		t.Fatal("unsupported format accepted", w.Code, w.Body)
	}
}

type sourceSyncReadFunc func([]byte) (int, error)

func (f sourceSyncReadFunc) Read(p []byte) (int, error) { return f(p) }

func TestSourceSyncDOCX(t *testing.T) {
	original := wordTestDOCX(t)
	s := testServer(t)
	d := editableImport(t, s, "docx", original)
	expectSourceSyncRevision(t, sourceSyncRequest(t, s, d.ID, bytes.NewReader(original)), 0)
	path := filepath.Join(t.TempDir(), "changed.docx")
	if err := markdownToDOCX(context.Background(), "# WordSyncUpdated\n\nChanged text\n", path); err != nil {
		t.Fatal(err)
	}
	updated, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	expectSourceSyncRevision(t, sourceSyncRequest(t, s, d.ID, bytes.NewReader(updated)), 2)
	expectSourceSyncRevision(t, sourceSyncRequest(t, s, d.ID, bytes.NewReader(updated)), 0)
	if w := sourceSyncRequest(t, s, d.ID, strings.NewReader("not a valid DOCX")); w.Code != 400 {
		t.Fatal(w.Code, w.Body)
	}
	if snap := editableSnapshot(t, s, d.ID); snap.Revision != 2 || snap.Content == nil || !strings.Contains(*snap.Content, "WordSyncUpdated") {
		t.Fatal(snap)
	}
}
