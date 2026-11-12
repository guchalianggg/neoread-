package neoread

import (
	"bytes"
	"fmt"
	"net/http/httptest"
	"testing"
)

func TestPaperAttachmentFileRangesRequireAuthentication(t *testing.T) {
	s := testServer(t)
	d := attachmentPaper(t, s, 1)
	other := attachmentPaper(t, s, 2)
	data := testPDF(2)
	a := addedAttachment(t, s, d.ID, "supplement.pdf", data)
	endpoint := "/api/documents/" + d.ID + "/attachments/" + a.ID + "/file"
	serve := func(method, path, rangeHeader, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1:17840"+path, nil)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		if rangeHeader != "" {
			r.Header.Set("Range", rangeHeader)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	w := serve("GET", endpoint, "bytes=0-63", "test-secret")
	if w.Code != 206 || !bytes.Equal(w.Body.Bytes(), data[:64]) || w.Header().Get("Accept-Ranges") != "bytes" || w.Header().Get("Content-Range") != fmt.Sprintf("bytes 0-63/%d", len(data)) || w.Header().Get("Content-Length") != "64" {
		t.Fatalf("range response: %d %v", w.Code, w.Header())
	}
	w = serve("HEAD", endpoint, "", "test-secret")
	if w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Content-Length") != fmt.Sprint(len(data)) {
		t.Fatalf("head response: %d %v", w.Code, w.Header())
	}
	if w := serve("GET", endpoint, "bytes=0-63", ""); w.Code != 401 {
		t.Fatalf("unauthenticated range: %d", w.Code)
	}
	if w := serve("GET", "/api/documents/"+other.ID+"/attachments/"+a.ID+"/file", "bytes=0-63", "test-secret"); w.Code != 404 {
		t.Fatalf("cross-parent range: %d", w.Code)
	}
	if w := serve("GET", endpoint, "bytes=999999-", "test-secret"); w.Code != 416 {
		t.Fatalf("unsatisfiable range: %d", w.Code)
	}
}
