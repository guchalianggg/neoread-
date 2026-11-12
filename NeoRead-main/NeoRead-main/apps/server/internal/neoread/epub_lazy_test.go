package neoread

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEPUBChapterSubscriptionDoesNotReadDistantChaptersOrTranslations(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	var d Document
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &d) != nil {
		t.Fatal(response.Body.String())
	}
	manifest, err := s.readerManifest(d.ID)
	if err != nil {
		t.Fatal(err)
	}
	href := manifest.ReadingOrder[0].Href
	_, blocks, err := s.readerChapter(d.ID, href)
	if err != nil || len(blocks.translationItems()) == 0 {
		t.Fatal(err)
	}
	name, _ := safeResource(manifest.ReadingOrder[len(manifest.ReadingOrder)-1].Href)
	if err := os.Remove(filepath.Join(s.Store.Root, "cache", d.ID, filepath.FromSlash(name))); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.DB.Exec("INSERT INTO translations(document_id,block_id,source_hash,status,body) VALUES(?,?,?,?,?)", d.ID, "unrelated", "hash", "complete", "invalid JSON"); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/documents/"+d.ID+"/translations/stream?href="+url.QueryEscape(href), nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)
	next := func() string {
		t.Helper()
		for scanner.Scan() {
			if strings.HasPrefix(scanner.Text(), "data: ") {
				return strings.TrimPrefix(scanner.Text(), "data: ")
			}
		}
		t.Fatalf("stream ended: %v", scanner.Err())
		return ""
	}
	var snapshot []TranslationBlock
	if err := json.Unmarshal([]byte(next()), &snapshot); err != nil || len(snapshot) != len(blocks.translationItems()) {
		t.Fatalf("invalid chapter snapshot: %v", err)
	}
	current := snapshot[0]
	current.Status = "complete"
	s.translationMu.Lock()
	s.publishTranslation(d.ID, TranslationBlock{BlockID: "unrelated", Status: "complete"})
	s.publishTranslation(d.ID, current)
	s.translationMu.Unlock()
	var live TranslationBlock
	if err := json.Unmarshal([]byte(next()), &live); err != nil || live.BlockID != current.BlockID {
		t.Fatalf("unscoped live event: %+v %v", live, err)
	}
	cancel()
	res.Body.Close()
	invalid := request(t, s, "GET", "/api/documents/"+d.ID+"/translations/stream?href=../escape", nil)
	if invalid.Code != 404 {
		t.Fatal(invalid.Code)
	}
}

func TestEPUBSourceNoteRecoveryDoesNotReadChapterBodies(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	var d Document
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &d) != nil {
		t.Fatal(response.Body.String())
	}
	manifest, err := s.readerManifest(d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Store.saveProcessing(Processing{DocumentID: d.ID, Status: "complete"}); err != nil {
		t.Fatal(err)
	}
	location, _ := json.Marshal(map[string]string{"type": "epub", "href": manifest.ReadingOrder[0].Href})
	note := Annotation{ID: "source-note", DocumentID: d.ID, Kind: "note", Location: location, Note: "keep"}
	if _, err := s.Store.DB.Exec("INSERT INTO annotations(id,document_id,body) VALUES(?,?,?)", note.ID, d.ID, jsonText(note)); err != nil {
		t.Fatal(err)
	}
	for _, link := range manifest.ReadingOrder {
		name, _ := safeResource(link.Href)
		if err := os.Remove(filepath.Join(s.Store.Root, "cache", d.ID, filepath.FromSlash(name))); err != nil {
			t.Fatal(err)
		}
	}
	response = request(t, s, "POST", "/api/documents/"+d.ID+"/annotations/recover", strings.NewReader(`{}`))
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"checked":true`) {
		t.Fatal(response.Body.String())
	}
	var body string
	if err := s.Store.DB.QueryRow("SELECT body FROM annotations WHERE id=?", note.ID).Scan(&body); err != nil || body != jsonText(note) {
		t.Fatal("source note changed", err)
	}
}
