package neoread

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestDocumentNavigationPersistenceAndConflicts(t *testing.T) {
	s := testServer(t)
	imported := upload(t, s, "reading-notes.pdf", sample(t, "reading-notes.pdf"))
	var d Document
	if err := json.Unmarshal(imported.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	path := "/api/documents/" + d.ID + "/navigation"
	get := request(t, s, "GET", path, nil)
	if get.Code != 200 || !strings.Contains(get.Body.String(), `"revision":0`) {
		t.Fatal(get.Body.String())
	}
	body := `{"revision":0,"entries":{"outline:0":{"label":"新标题","kind":"bookmark","parentId":null,"collapsed":true}}}`
	first := request(t, s, "PUT", path, strings.NewReader(body))
	if first.Code != 200 {
		t.Fatal(first.Code, first.Body.String())
	}
	conflict := request(t, s, "PUT", path, strings.NewReader(body))
	if conflict.Code != 409 {
		t.Fatal("stale write accepted", conflict.Code)
	}
	for revision := 1; revision <= 2; revision++ {
		next := request(t, s, "PUT", path, strings.NewReader(fmt.Sprintf(`{"revision":%d,"entries":{"outline:0":{"label":"保留","deleted":true}}}`, revision)))
		if next.Code != 200 {
			t.Fatal(next.Code, next.Body.String())
		}
	}
	get = request(t, s, "GET", path, nil)
	if !strings.Contains(get.Body.String(), `"revision":3`) || !strings.Contains(get.Body.String(), "保留") {
		t.Fatal(get.Body.String())
	}
	if !strings.Contains(get.Body.String(), `"deleted":true`) {
		t.Fatal("deleted state lost", get.Body.String())
	}
	// A fresh database connection sees the same saved edits.
	reopened, err := OpenStore(s.Store.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.DB.Close()
	var revision int
	if err = reopened.DB.QueryRow("SELECT revision FROM document_navigation WHERE document_id=?", d.ID).Scan(&revision); err != nil || revision != 3 {
		t.Fatal(revision, err)
	}
	for _, bad := range []string{
		`{"revision":3,"entries":{"a":{"parentId":"b"},"b":{"parentId":"a"}}}`,
		`{"revision":3,"entries":{"a":{"label":" "}}}`,
		`{"revision":3,"entries":{"a":{"kind":"script"}}}`,
		`{"revision":3,"entries":{"__proto__":{}}}`,
	} {
		if w := request(t, s, "PUT", path, strings.NewReader(bad)); w.Code != 400 {
			t.Fatal("accepted invalid navigation", bad, w.Code)
		}
	}
}
