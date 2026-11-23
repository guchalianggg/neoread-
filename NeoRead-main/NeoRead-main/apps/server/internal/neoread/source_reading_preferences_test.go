package neoread

import (
	"io"
	"strings"
	"testing"
)

func sourceReadingPreferenceDocument(t *testing.T, s *Server, kind, filename string, original bool) string {
	t.Helper()
	documentID := id()
	if _, err := s.Store.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at)
		VALUES(?,?,'Source test','',1,'t','t')`, documentID, kind); err != nil {
		t.Fatal(err)
	}
	if filename != "" {
		hash := id() + id()
		if original {
			hash = documentID + id()
		}
		if _, err := s.Store.DB.Exec(`INSERT INTO paper_attachments(id,document_id,kind,title,filename,created_at,sha256)
			VALUES(?,?,'file',?,?,'t',?)`, id(), documentID, filename, filename, hash); err != nil {
			t.Fatal(err)
		}
	}
	return documentID
}

func TestSourceReadingPreferencesPersistAndIsolateDocuments(t *testing.T) {
	s := testServer(t)
	markdown := sourceReadingPreferenceDocument(t, s, "epub", "source.md", true)
	word := sourceReadingPreferenceDocument(t, s, "epub", "source.docx", true)
	check := func(s *Server, method, id, body, want string) {
		t.Helper()
		var reader io.Reader
		if body != "" {
			reader = strings.NewReader(body)
		}
		w := request(t, s, method, "/api/preferences/source-reading-"+id, reader)
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != want {
			t.Fatalf("%s %s: got %d %s; want 200 %s", method, id, w.Code, w.Body.String(), want)
		}
	}
	const initial = `{"width":"narrow","pinned":false}`
	const savedMarkdown = `{"width":"standard","pinned":true,"position":{"version":1,"block":7}}`
	const savedWord = `{"width":"wide","pinned":false,"position":null}`
	check(s, "GET", markdown, "", `{}`)
	check(s, "PUT", markdown, initial, initial)
	check(s, "PUT", markdown, savedMarkdown, savedMarkdown)
	check(s, "GET", word, "", `{}`)
	check(s, "PUT", word, savedWord, savedWord)

	if err := s.Store.DB.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.DB.Close() })
	reopened := NewServer(store, "test-secret", "")
	t.Cleanup(reopened.Close)
	check(reopened, "GET", markdown, "", savedMarkdown)
	check(reopened, "GET", word, "", savedWord)
}

func TestSourceReadingPreferencesRejectIneligibleDocuments(t *testing.T) {
	s := testServer(t)
	trashed := sourceReadingPreferenceDocument(t, s, "epub", "source.markdown", true)
	if w := request(t, s, "GET", "/api/preferences/source-reading-"+trashed, nil); w.Code != 200 {
		t.Fatalf("active .markdown: got %d %s; want 200", w.Code, w.Body.String())
	}
	if _, err := s.Store.DB.Exec("UPDATE documents SET deleted_at='t' WHERE id=?", trashed); err != nil {
		t.Fatal(err)
	}
	for label, documentID := range map[string]string{
		"missing":              id(),
		"trashed":              trashed,
		"spreadsheet source":   sourceReadingPreferenceDocument(t, s, "epub", "source.xlsx", true),
		"unrelated attachment": sourceReadingPreferenceDocument(t, s, "epub", "attachment.md", false),
		"pdf":                  sourceReadingPreferenceDocument(t, s, "pdf", "source.docx", true),
		"uppercase":            strings.Repeat("A", 32),
		"short":                strings.Repeat("a", 31),
		"long":                 strings.Repeat("a", 33),
		"non-hex":              strings.Repeat("g", 32),
	} {
		t.Run(label, func(t *testing.T) {
			path := "/api/preferences/source-reading-" + documentID
			if w := request(t, s, "GET", path, nil); w.Code != 404 {
				t.Fatalf("GET: got %d %s; want 404", w.Code, w.Body.String())
			}
			if w := request(t, s, "PUT", path, strings.NewReader(`{"width":"wide","pinned":true}`)); w.Code != 404 {
				t.Fatalf("PUT: got %d %s; want 404", w.Code, w.Body.String())
			}
		})
	}
	var saved int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM settings WHERE key GLOB 'preferences:source-reading-*'").Scan(&saved); err != nil || saved != 0 {
		t.Fatalf("ineligible requests persisted %d entries (err: %v)", saved, err)
	}
}

func TestSourceReadingPreferencesValidateBody(t *testing.T) {
	s := testServer(t)
	path := "/api/preferences/source-reading-" + sourceReadingPreferenceDocument(t, s, "epub", "source.doc", true)
	const valid = `{"width":"standard","pinned":false}`
	for label, body := range map[string]string{
		"null state":       `null`,
		"invalid width":    `{"width":"full","pinned":true}`,
		"missing width":    `{"pinned":false}`,
		"missing pin":      `{"width":"standard"}`,
		"null pin":         `{"width":"standard","pinned":null}`,
		"string pin":       `{"width":"standard","pinned":"false"}`,
		"array position":   `{"width":"standard","pinned":true,"position":[]}`,
		"string position":  `{"width":"standard","pinned":true,"position":"text"}`,
		"unexpected field": `{"width":"standard","pinned":true,"content":"raw content"}`,
		"extra JSON":       valid + ` {}`,
	} {
		t.Run(label, func(t *testing.T) {
			if w := request(t, s, "PUT", path, strings.NewReader(body)); w.Code != 400 {
				t.Fatalf("got %d %s; want 400", w.Code, w.Body.String())
			}
		})
	}
	atLimit := valid + strings.Repeat(" ", 4096-len(valid))
	for _, oversized := range []string{
		`{"width":"wide","pinned":true,"position":{"x":"` + strings.Repeat("a", 4096) + `"}}`,
		atLimit + " ",
	} {
		if w := request(t, s, "PUT", path, strings.NewReader(oversized)); w.Code != 413 {
			t.Fatalf("got %d %s; want 413", w.Code, w.Body.String())
		}
	}
	if w := request(t, s, "GET", path, nil); w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{}` {
		t.Fatalf("invalid saves changed settings: %d %s", w.Code, w.Body.String())
	}
	if w := request(t, s, "PUT", path, strings.NewReader(atLimit)); w.Code != 200 {
		t.Fatalf("exact limit: got %d %s; want 200", w.Code, w.Body.String())
	}
}
