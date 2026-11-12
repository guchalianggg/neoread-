package neoread

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"strings"
	"testing"
)

// bookEPUB adds publication details and a cover image to the sample EPUB.
func bookEPUB(t *testing.T) []byte {
	t.Helper()
	original := sample(t, "the-art-of-reading.epub")
	source, err := zip.NewReader(bytes.NewReader(original), int64(len(original)))
	if err != nil {
		t.Fatal(err)
	}
	var cover bytes.Buffer
	if err = png.Encode(&cover, image.NewRGBA(image.Rect(0, 0, 4, 6))); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	writer := zip.NewWriter(&out)
	for _, file := range source.File {
		r, _ := file.Open()
		body, _ := io.ReadAll(r)
		r.Close()
		if file.Name == "EPUB/package.opf" {
			body = bytes.Replace(body, []byte("<dc:language>"), []byte(`<dc:publisher>示例出版社</dc:publisher><dc:date>2021-03-04T00:00:00Z</dc:date><dc:identifier>urn:isbn:978-7-111-12345-6</dc:identifier><dc:description>&lt;p&gt;第一段&lt;/p&gt;&lt;p&gt;第二  段&lt;/p&gt;</dc:description><dc:language>`), 1)
			body = bytes.Replace(body, []byte("</manifest>"), []byte(`<item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/></manifest>`), 1)
		}
		w, _ := writer.Create(file.Name)
		w.Write(body)
	}
	w, _ := writer.Create("EPUB/images/cover.png")
	w.Write(cover.Bytes())
	writer.Close()
	return out.Bytes()
}

func TestEPUBImportReadsBookDetailsAndCover(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "book.epub", bookEPUB(t))
	if response.Code != 201 {
		t.Fatal(response.Code, response.Body.String())
	}
	var d Document
	json.Unmarshal(response.Body.Bytes(), &d)
	m := d.Metadata
	if m.Publisher != "示例出版社" || m.Date != "2021-03-04" || m.ISBN != "9787111123456" || m.Language != "zh-CN" || m.Abstract != "第一段\n第二 段" {
		t.Fatalf("book details: %+v", m)
	}
	if m.Sources["publisher"] != "file" || m.Lookup != "" {
		t.Fatalf("sources: %+v", m)
	}
	response = request(t, s, "GET", "/pub/test-secret/"+d.ID+"/"+coverResource, nil)
	if response.Code != 200 || response.Header().Get("Content-Type") != "image/png" {
		t.Fatal(response.Code, response.Header())
	}
	if _, err := png.DecodeConfig(response.Body); err != nil {
		t.Fatal(err)
	}
	response = request(t, s, "PUT", "/api/documents/"+d.ID+"/cover", strings.NewReader("x"))
	if response.Code != 400 {
		t.Fatal("EPUB covers come from the book:", response.Code)
	}
}

func TestEPUBWithoutCoverHasNoCover(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "sample.epub", sample(t, "the-art-of-reading.epub"))
	var d Document
	json.Unmarshal(response.Body.Bytes(), &d)
	if response = request(t, s, "GET", "/pub/test-secret/"+d.ID+"/"+coverResource, nil); response.Code != 404 {
		t.Fatal(response.Code)
	}
}

func TestPDFCoverUpload(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "notes.pdf", sample(t, "reading-notes.pdf"))
	var d Document
	json.Unmarshal(response.Body.Bytes(), &d)
	cover := "/pub/test-secret/" + d.ID + "/" + coverResource
	if response = request(t, s, "GET", cover, nil); response.Code != 404 {
		t.Fatal("no cover before upload:", response.Code)
	}
	var png bytes.Buffer
	_ = pngEncode(&png)
	if response = request(t, s, "PUT", "/api/documents/"+d.ID+"/cover", &png); response.Code != 400 {
		t.Fatal("only JPEG is accepted:", response.Code)
	}
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 30, 40)), nil); err != nil {
		t.Fatal(err)
	}
	data := jpg.Bytes()
	if response = request(t, s, "PUT", "/api/documents/"+d.ID+"/cover", bytes.NewReader(data)); response.Code != 204 {
		t.Fatal(response.Code, response.Body.String())
	}
	response = request(t, s, "GET", cover, nil)
	if response.Code != 200 || response.Header().Get("Content-Type") != "image/jpeg" || !bytes.Equal(response.Body.Bytes(), data) {
		t.Fatal(response.Code, response.Header())
	}
	if response = request(t, s, "PUT", "/api/documents/"+d.ID+"/cover", bytes.NewReader(make([]byte, maxCoverBytes+1))); response.Code != 413 {
		t.Fatal("oversized cover:", response.Code)
	}
}

func pngEncode(w io.Writer) error { return png.Encode(w, image.NewRGBA(image.Rect(0, 0, 2, 2))) }

func TestRatingValidation(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "sample.epub", sample(t, "the-art-of-reading.epub"))
	var d Document
	json.Unmarshal(response.Body.Bytes(), &d)
	path := "/api/documents/" + d.ID
	for _, bad := range []string{`6`, `-1`, `3.5`, `"4"`} {
		if w := request(t, s, "PATCH", path, strings.NewReader(`{"metadata":{"rating":`+bad+`}}`)); w.Code != 400 {
			t.Fatal(bad, w.Code)
		}
	}
	if w := request(t, s, "PATCH", path, strings.NewReader(`{"metadata":{"rating":4}}`)); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if got, _ := s.Store.Document(d.ID); got.Metadata.Rating != 4 {
		t.Fatal(got.Metadata.Rating)
	}
	request(t, s, "PATCH", path, strings.NewReader(`{"metadata":{"rating":0}}`))
	if got, _ := s.Store.Document(d.ID); got.Metadata.Rating != 0 {
		t.Fatal("rating not cleared:", got.Metadata.Rating)
	}
}

func TestFillEPUBBookMetadataKeepsManualFields(t *testing.T) {
	s := testServer(t)
	response := upload(t, s, "book.epub", bookEPUB(t))
	var d Document
	json.Unmarshal(response.Body.Bytes(), &d)
	// Simulate a book imported before details were read, with one manual edit.
	if _, err := s.Store.DB.Exec(`UPDATE documents SET metadata='{"publisher":"手填出版社","sources":{"publisher":"manual"}}' WHERE id=?`, d.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.fillEPUBBookMetadata(); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Store.Document(d.ID)
	if got.Metadata.Publisher != "手填出版社" || got.Metadata.ISBN != "9787111123456" {
		t.Fatalf("%+v", got.Metadata)
	}
	// The migration runs once; later edits are not refilled.
	s.Store.DB.Exec(`UPDATE documents SET metadata='{}' WHERE id=?`, d.ID)
	if err := s.fillEPUBBookMetadata(); err != nil {
		t.Fatal(err)
	}
	if got, _ = s.Store.Document(d.ID); got.Metadata.ISBN != "" {
		t.Fatal("migration repeated")
	}
}

func TestBookISBN(t *testing.T) {
	for in, want := range map[string]string{"urn:isbn:0-306-40615-2": "0306406152", "ISBN:978 7 111 12345 6": "9787111123456", "urn:uuid:1234": "", "123456789X": "123456789X", "12345X7890": ""} {
		if got := bookISBN(in); got != want {
			t.Errorf("%s: %q", in, got)
		}
	}
}
