package neoread

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"neoread.local/server/internal/scholar"
)

func TestLookupArxivPublicationRefreshesExistingPaper(t *testing.T) {
	for _, tc := range []struct {
		name string
		ids  PaperMetadata
	}{
		{"identifier", PaperMetadata{ArXiv: "1706.03762v1"}},
		{"URL only", PaperMetadata{URL: "https://arxiv.org/abs/1706.03762v1"}},
		{"arXiv DOI only", PaperMetadata{DOI: "10.48550/arXiv.1706.03762"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := testServer(t)
			var unavailable atomic.Bool
			fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/arxiv":
					w.Write([]byte(lookupAtom))
				case r.URL.Path == "/s2/ARXIV:1706.03762":
					if unavailable.Load() {
						w.WriteHeader(http.StatusServiceUnavailable)
					} else {
						w.Write([]byte(`{"title":"Attention Is All You Need","venue":"Nature Methods","publicationTypes":["JournalArticle"],"externalIds":{"ArXiv":"1706.03762","DOI":"10.1000/published"}}`))
					}
				case strings.HasPrefix(r.URL.Path, "/crossref/"):
					if unavailable.Load() {
						w.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					w.Write([]byte(`{"message":{"type":"journal-article","title":["Attention Is All You Need"],"container-title":["Nature Methods"],"volume":"21","issue":"3","page":"1-9","publisher":"Example Publisher","issued":{"date-parts":[[2024,3]]}}}`))
				default:
					t.Errorf("unexpected request: %s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			t.Cleanup(fixture.Close)
			c := scholar.New(maxImportBytes)
			c.AllowPrivateHosts = true
			c.ArXivAPI, c.Crossref, c.SemanticScholar = fixture.URL+"/arxiv", fixture.URL+"/crossref/", fixture.URL+"/s2/"
			s.scholar = c

			w := uploadTo(t, s, "papers", "paper.pdf", testPDF(2))
			var d Document
			if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &d) != nil {
				t.Fatal(w.Body.String())
			}
			initial := tc.ids
			initial.Venue, initial.ItemType, initial.Date = "arXiv", "preprint", "2017"
			if _, err := s.applyFound(d.ID, initial, "", "lookup", "done"); err != nil {
				t.Fatal(err)
			}
			w = request(t, s, "POST", "/api/documents/"+d.ID+"/metadata/lookup", nil)
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			got, err := s.Store.Document(d.ID)
			if err != nil || got.Metadata.ItemType != "journal" || got.Metadata.Venue != "Nature Methods" || got.Metadata.DOI != "10.1000/published" || got.Metadata.Date != "2024-03" || got.Metadata.Volume != "21" || got.Metadata.Issue != "3" || got.Metadata.Pages != "1-9" || got.Metadata.Lookup != "done" || got.Metadata.Sources["venue"] != "lookup" || got.Metadata.ArXiv == "" {
				t.Fatalf("published data was not persisted: %+v %v", got.Metadata, err)
			}

			// A later best-effort lookup must not erase a known publication.
			unavailable.Store(true)
			w = request(t, s, "POST", "/api/documents/"+d.ID+"/metadata/lookup", nil)
			got, err = s.Store.Document(d.ID)
			if w.Code != 200 || err != nil || got.Metadata.Venue != "Nature Methods" || got.Metadata.ItemType != "journal" || got.Metadata.Date != "2024-03" || got.Metadata.DOI != "10.1000/published" || got.Metadata.Publisher != "Example Publisher" {
				t.Fatalf("service failure downgraded publication: %+v %v", got.Metadata, err)
			}

			unavailable.Store(false)
			w = request(t, s, "PATCH", "/api/documents/"+d.ID, strings.NewReader(`{"metadata":{"venue":"Custom Journal","itemType":"conference","date":"2025"}}`))
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			w = request(t, s, "POST", "/api/documents/"+d.ID+"/metadata/lookup", nil)
			got, err = s.Store.Document(d.ID)
			if w.Code != 200 || err != nil || got.Metadata.Venue != "Custom Journal" || got.Metadata.ItemType != "conference" || got.Metadata.Date != "2025" || got.Metadata.Sources["venue"] != "manual" {
				t.Fatalf("manual publication fields overwritten: %+v %v", got.Metadata, err)
			}
		})
	}
}

func TestArxivFallbackDoesNotDowngradeStructuredPublication(t *testing.T) {
	for _, kind := range []string{"journal", "conference"} {
		for _, fallback := range []string{"preprint", "other"} {
			m := PaperMetadata{ItemType: kind, Venue: "Known venue", Date: "2024", DOI: "10.1000/published"}
			m.Merge(PaperMetadata{ItemType: fallback, Venue: "Unstructured reference", Date: "2020", DOI: "10.48550/arXiv.1706.03762", ArXiv: "1706.03762", Abstract: "New abstract"}, "lookup")
			if m.ItemType != kind || m.Venue != "Known venue" || m.Date != "2024" || m.DOI != "10.1000/published" || m.ArXiv != "1706.03762" || m.Abstract != "New abstract" {
				t.Fatalf("%s/%s: %+v", kind, fallback, m)
			}
		}
	}
}

func TestFromScholarKeepsArxivJournalReferenceVerbatim(t *testing.T) {
	const ref = "Advances in Neural Information Processing Systems 30 (2017)"
	m := fromScholar(scholar.Metadata{ArXiv: "1706.03762", ItemType: "other", Venue: ref, UnstructuredVenue: true})
	if m.Venue != ref || m.ItemType != "other" {
		t.Fatalf("unstructured reference was normalized/truncated: %+v", m)
	}
	canonical := fromScholar(scholar.Metadata{ArXiv: "1706.03762", ItemType: "conference", Venue: "NeurIPS"})
	if canonical.Venue == "" || canonical.ItemType != "conference" {
		t.Fatalf("structured venue was lost: %+v", canonical)
	}
}

func TestArxivFallbackReplacesMisclassifiedPreprintPlaceholder(t *testing.T) {
	for _, venue := range []string{"", "arXiv", "arXiv (preprint)"} {
		m := PaperMetadata{ItemType: "journal", Venue: venue}
		m.Merge(PaperMetadata{ArXiv: "1706.03762", ItemType: "other", Venue: "Nature Methods 21 (2024)"}, "lookup")
		if m.ItemType != "other" || m.Venue != "Nature Methods 21 (2024)" {
			t.Fatalf("preprint placeholder was locked as a known publication: %+v", m)
		}
	}
}
