package neoread

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestEPUBImageBlockIsServedAndAttachedAsPNG(t *testing.T) {
	s := testServer(t)
	s.Token = "test-secret"
	response := upload(t, s, "the-art-of-reading.epub", sample(t, "the-art-of-reading.epub"))
	var doc Document
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &doc) != nil {
		t.Fatal(response.Body.String())
	}
	cache := filepath.Join(s.Store.Root, "cache", doc.ID)
	if err := os.MkdirAll(filepath.Join(cache, "check"), 0700); err != nil {
		t.Fatal(err)
	}
	picture := image.NewRGBA(image.Rect(0, 0, 4, 3))
	picture.Set(1, 1, color.RGBA{200, 10, 10, 255})
	var data bytes.Buffer
	if err := jpeg.Encode(&data, picture, nil); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"check/pic.jpg": data.String(),
		"check/c.xhtml": `<html><body><p>Before.</p><img src="pic.jpg" alt="A chart"/></body></html>`,
		"manifest.json": `{"readingOrder":[{"href":"check/c.xhtml","type":"application/xhtml+xml"}]}`,
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(cache, filepath.FromSlash(name)), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	blocks, err := s.readEPUBBlocks(doc.ID)
	if err != nil || len(blocks) != 2 || blocks[1].Image != "check/pic.jpg" {
		t.Fatalf("blocks %+v %v", blocks, err)
	}
	w := request(t, s, "GET", "/pub/test-secret/"+doc.ID+"/assets/"+blocks[1].ID+".png", nil)
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("image route: %d %s", w.Code, w.Body.String())
	}
	if config, err := png.DecodeConfig(w.Body); err != nil || config.Width != 4 || config.Height != 3 {
		t.Fatalf("not a PNG of the picture: %+v %v", config, err)
	}
	block, _, err := s.readBlockImage(doc.ID, blocks[1].ID)
	if err != nil || block.Page != 0 || block.Caption != "A chart" {
		t.Fatalf("attachment %+v %v", block, err)
	}
	for _, id := range []string{blocks[0].ID, "p1-b1", "../c"} {
		if _, _, err := s.readBlockImage(doc.ID, id); err == nil {
			t.Fatalf("%s resolved to an image", id)
		}
	}
	// The publication's own files are still served as they are.
	if w = request(t, s, "GET", "/pub/test-secret/"+doc.ID+"/check/pic.jpg", nil); w.Code != 200 {
		t.Fatalf("publication resource: %d", w.Code)
	}
}
