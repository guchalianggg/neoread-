package scholar

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const publishedJournal = `{"message":{"type":"journal-article","title":["Published title"],"container-title":["Nature Methods"],"volume":"21","issued":{"date-parts":[[2024,3]]}}}`

func TestArxivPublicationLookup(t *testing.T) {
	for _, tc := range []struct {
		name, doi, ref, s2, crossref, venue, kind, wantDOI string
		s2Status, wantS2, wantCrossref                     int
	}{
		{name: "DOI takes priority", doi: "10.1000/published", crossref: publishedJournal, venue: "Nature Methods", kind: "journal", wantDOI: "10.1000/published", wantCrossref: 1},
		{name: "journal without DOI", s2: `{"title":"Attention Is All You Need","venue":"Nature Methods","publicationTypes":["JournalArticle"],"externalIds":{"ArXiv":"1706.03762"}}`, venue: "Nature Methods", kind: "journal", wantS2: 1},
		{name: "conference is not a journal", s2: `{"title":"Attention Is All You Need","venue":"NeurIPS","publicationTypes":["Conference"]}`, venue: "NeurIPS", kind: "conference", wantS2: 1},
		{name: "untyped venue remains unclassified", s2: `{"title":"Attention Is All You Need","venue":"NeurIPS"}`, venue: "NeurIPS", kind: "other", wantS2: 1},
		{name: "journal object", s2: `{"title":"Attention Is All You Need","journal":{"name":"Nature Methods","volume":"21","pages":"1-9"},"publicationTypes":["JournalArticle"]}`, venue: "Nature Methods", kind: "journal", wantS2: 1},
		{name: "journal replaces arxiv venue", s2: `{"title":"Attention Is All You Need","venue":"arXiv.org","journal":{"name":"Nature Methods"},"publicationTypes":["JournalArticle"]}`, venue: "Nature Methods", kind: "journal", wantS2: 1},
		{name: "S2 discovers DOI", s2: `{"title":"Attention Is All You Need","externalIds":{"DOI":"10.1000/published"}}`, crossref: publishedJournal, venue: "Nature Methods", kind: "journal", wantDOI: "10.1000/published", wantS2: 1, wantCrossref: 1},
		{name: "Crossref unavailable", doi: "10.1000/published", s2: `{"title":"Attention Is All You Need","venue":"NeurIPS","publicationTypes":["Conference"]}`, venue: "NeurIPS", kind: "conference", wantDOI: "10.1000/published", wantS2: 1, wantCrossref: 1},
		{name: "Crossref posted content", doi: "10.1000/posted", crossref: `{"message":{"type":"posted-content","title":["Preprint"],"container-title":["arXiv"]}}`, venue: "arXiv (preprint)", kind: "preprint", wantDOI: "10.1000/posted", wantS2: 1, wantCrossref: 1},
		{name: "journal reference fallback", ref: "Nature Methods 21, 1-9 (2024)", venue: "Nature Methods 21, 1-9 (2024)", kind: "other", wantS2: 1},
		{name: "reference is not assumed journal", ref: "Proceedings of NeurIPS 2023", venue: "Proceedings of NeurIPS 2023", kind: "other", wantS2: 1},
		{name: "reference normalized by S2", ref: "Advances in Neural Information Processing Systems 30 (2017)", s2: `{"title":"Attention Is All You Need","venue":"NeurIPS","publicationTypes":["Conference"]}`, venue: "NeurIPS", kind: "conference", wantS2: 1},
		{name: "arxiv DOI is not publication", doi: "10.48550/arXiv.1706.03762", s2: `{"title":"Attention Is All You Need","venue":"ArXiv","publicationTypes":["JournalArticle"]}`, venue: "arXiv (preprint)", kind: "preprint", wantDOI: "10.48550/arXiv.1706.03762", wantS2: 1},
		{name: "preprint journal label is not publication", s2: `{"title":"Attention Is All You Need","journal":{"name":"arXiv preprint arXiv:1706.03762"},"publicationTypes":["JournalArticle"]}`, venue: "arXiv (preprint)", kind: "preprint", wantS2: 1},
		{name: "conflicting identifier rejected", s2: `{"title":"Another paper","venue":"Nature","externalIds":{"ArXiv":"2401.01234","DOI":"10.1000/wrong"},"publicationTypes":["JournalArticle"]}`, venue: "arXiv (preprint)", kind: "preprint", wantS2: 1},
		{name: "limited service keeps reference", ref: "Nature Methods 21, 1-9 (2024)", s2Status: 429, venue: "Nature Methods 21, 1-9 (2024)", kind: "other", wantS2: 1},
		{name: "no publication found", venue: "arXiv (preprint)", kind: "preprint", wantS2: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s2Hits, crossrefHits := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/arxiv":
					if got := r.URL.Query().Get("id_list"); got != "1706.03762" {
						t.Errorf("metadata must query latest version: %q", got)
					}
					feed := strings.Replace(atom, "<arxiv:doi>10.5555/3295222.3295349</arxiv:doi>", "<arxiv:doi>"+tc.doi+"</arxiv:doi><arxiv:journal_ref>"+tc.ref+"</arxiv:journal_ref>", 1)
					w.Write([]byte(feed))
				case strings.HasPrefix(r.URL.Path, "/crossref/"):
					crossrefHits++
					if tc.crossref == "" {
						http.NotFound(w, r)
					} else {
						w.Write([]byte(tc.crossref))
					}
				case r.URL.Path == "/s2/ARXIV:1706.03762":
					s2Hits++
					if !strings.Contains(r.URL.Query().Get("fields"), "journal") {
						t.Error("journal field was not requested")
					}
					if tc.s2Status != 0 {
						w.WriteHeader(tc.s2Status)
					} else if tc.s2 == "" {
						http.NotFound(w, r)
					} else {
						w.Write([]byte(tc.s2))
					}
				default:
					t.Errorf("unexpected request (no title search allowed): %s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			t.Cleanup(server.Close)
			c := New(1 << 20)
			c.AllowPrivateHosts = true
			c.ArXivAPI, c.Crossref, c.SemanticScholar = server.URL+"/arxiv", server.URL+"/crossref/", server.URL+"/s2/"
			m, err := c.Lookup(context.Background(), Identifiers{ArXiv: "1706.03762v1"})
			if err != nil || m.Venue != tc.venue || m.ItemType != tc.kind || m.DOI != tc.wantDOI {
				t.Fatalf("metadata: %+v, error: %v", m, err)
			}
			if m.ArXiv != "1706.03762v1" || m.URL != "https://arxiv.org/abs/1706.03762" || !strings.HasPrefix(m.Abstract, "The dominant") {
				t.Fatalf("preprint identity/abstract changed: %+v", m)
			}
			if s2Hits != tc.wantS2 || crossrefHits != tc.wantCrossref {
				t.Fatalf("requests: S2=%d Crossref=%d, want S2=%d Crossref=%d", s2Hits, crossrefHits, tc.wantS2, tc.wantCrossref)
			}
			if tc.name == "journal object" && (m.Volume != "21" || m.Pages != "1-9") {
				t.Fatalf("journal details lost: %+v", m)
			}
		})
	}
}

func TestArxivFromDOI(t *testing.T) {
	for input, want := range map[string]string{
		"10.48550/arXiv.1706.03762":                   "1706.03762",
		"https://doi.org/10.48550/arxiv.1706.03762v2": "1706.03762v2",
		"doi:10.48550/arXiv.hep-th/9901001":           "hep-th/9901001",
		"10.1000/arxiv.1706.03762":                    "",
		"10.48550/arxiv.not-an-id":                    "",
	} {
		if got := arxivFromDOI(input); got != want {
			t.Errorf("%q: got %q, want %q", input, got, want)
		}
	}
	c, _ := newFixture(t)
	m, err := c.Lookup(context.Background(), Identifiers{DOI: "10.48550/arXiv.1706.03762"})
	if err != nil || m.ArXiv != "1706.03762" || m.ItemType != "conference" {
		t.Fatalf("arXiv DOI must follow arXiv enrichment: %+v %v", m, err)
	}
}

func TestArxivPublicationCancellationKeepsMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()
	c := New(1 << 20)
	c.AllowPrivateHosts = true
	c.SemanticScholar = server.URL + "/"
	base := Metadata{Title: "Original title", ArXiv: "1706.03762", Venue: "Nature Methods 21 (2024)", ItemType: "other"}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	got := c.arxivPublication(ctx, base)
	if got.Title != base.Title || got.Venue != base.Venue || got.ItemType != base.ItemType || time.Since(start) > time.Second {
		t.Fatalf("cancelled enrichment lost metadata or ignored deadline: %+v", got)
	}
}

func TestPublicationDiagnosticsExcludeBibliographicText(t *testing.T) {
	var output bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })
	logPublicationLookup(context.Background(), "semantic_scholar", Metadata{Title: "PRIVATE_TITLE", Abstract: "PRIVATE_ABSTRACT", Venue: "PRIVATE_VENUE", DOI: "PRIVATE_DOI", ItemType: "journal"}, nil)
	var event map[string]any
	if json.Unmarshal(output.Bytes(), &event) != nil || event["msg"] != "paper.metadata.publication" || event["outcome"] != "found" || event["reasonCode"] != "matched_identifier" || strings.Contains(output.String(), "PRIVATE_") {
		t.Fatalf("unsafe/incomplete diagnostic: %s", output.String())
	}
	output.Reset()
	logPublicationLookup(context.Background(), "semantic_scholar", Metadata{}, context.DeadlineExceeded)
	if json.Unmarshal(output.Bytes(), &event) != nil || event["outcome"] != "unavailable" || event["reasonCode"] != "timeout" {
		t.Fatalf("missing timeout diagnosis: %s", output.String())
	}
}

func TestArxivLookupUsesKnownPublicationDOI(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/arxiv":
			feed := strings.Replace(atom, "<arxiv:doi>10.5555/3295222.3295349</arxiv:doi>", "<arxiv:journal_ref>Nature Methods 21 (2024)</arxiv:journal_ref>", 1)
			w.Write([]byte(feed))
		case strings.HasPrefix(r.URL.Path, "/crossref/"):
			if !strings.HasSuffix(r.URL.Path, "10.1000/published") {
				t.Errorf("known DOI lost: %s", r.URL.Path)
			}
			w.Write([]byte(publishedJournal))
		default:
			t.Errorf("known DOI should avoid S2 fallback: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	c := New(1 << 20)
	c.AllowPrivateHosts = true
	c.ArXivAPI, c.Crossref, c.SemanticScholar = server.URL+"/arxiv", server.URL+"/crossref/", server.URL+"/s2/"
	m, err := c.Lookup(context.Background(), Identifiers{ArXiv: "1706.03762v1", DOI: "10.1000/published"})
	if err != nil || m.Venue != "Nature Methods" || m.ItemType != "journal" || m.DOI != "10.1000/published" || m.UnstructuredVenue {
		t.Fatalf("existing DOI not used or canonical venue marked unstructured: %+v %v", m, err)
	}
}
