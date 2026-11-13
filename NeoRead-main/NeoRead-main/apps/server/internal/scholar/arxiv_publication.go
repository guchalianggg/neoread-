package scholar

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"
)

func arxivFromDOI(doi string) string {
	doi = strings.TrimSpace(doi)
	for _, prefix := range []string{"https://doi.org/", "http://doi.org/", "doi:"} {
		if strings.HasPrefix(strings.ToLower(doi), prefix) {
			doi = strings.TrimSpace(doi[len(prefix):])
			break
		}
	}
	const prefix = "10.48550/arxiv."
	if strings.HasPrefix(strings.ToLower(doi), prefix) {
		if match := arxivID.FindStringSubmatch(doi[len(prefix):]); match != nil {
			return match[1]
		}
	}
	return ""
}

func publicationVenue(venue string) bool {
	return strings.TrimSpace(venue) != "" && !words(venue)["arxiv"]
}

func publishedMetadata(m Metadata) bool {
	return m.ItemType != "preprint" && publicationVenue(m.Venue)
}

// Preserve the imported preprint's identity and abstract, not a different PDF.
func mergeArxivPublication(base, pub Metadata) Metadata {
	if pub.ItemType == "" {
		pub.ItemType = "other"
	}
	merged := overlay(base, pub)
	merged.Abstract, merged.ArXiv, merged.URL = base.Abstract, base.ArXiv, base.URL
	merged.UnstructuredVenue = pub.UnstructuredVenue
	return merged
}

// Only controlled provider/outcome codes enter logs, never bibliographic text.
func logPublicationLookup(ctx context.Context, provider string, pub Metadata, err error) {
	outcome, reason, level := "not_found", "no_publication", slog.LevelInfo
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		outcome, reason, level = "unavailable", "timeout", slog.LevelWarn
	case errors.Is(err, context.Canceled):
		outcome, reason = "cancelled", "cancelled"
	case errors.Is(err, ErrNotFound):
		reason = "not_found"
	case err != nil:
		var limited rateLimitError
		outcome, reason, level = "unavailable", "request_failed", slog.LevelWarn
		if errors.As(err, &limited) {
			reason = "rate_limited"
		}
	case publishedMetadata(pub):
		outcome, reason = "found", "matched_identifier"
	}
	slog.Log(ctx, level, "paper.metadata.publication", "provider", provider, "outcome", outcome, "reasonCode", reason)
}

func (c *Client) publicationCrossref(ctx context.Context, doi string) (Metadata, bool) {
	if strings.TrimSpace(doi) == "" || arxivFromDOI(doi) != "" || ctx.Err() != nil {
		return Metadata{}, false
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	pub, err := c.crossref(ctx, doi)
	logPublicationLookup(ctx, "crossref", pub, err)
	return pub, err == nil && publishedMetadata(pub)
}

// Enrichment is optional and bounded independently of PDF download. Never use
// fuzzy title matching to attach publication details to an arXiv identifier.
func (c *Client) arxivPublication(ctx context.Context, base Metadata) Metadata {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	if pub, ok := c.publicationCrossref(ctx, base.DOI); ok {
		return mergeArxivPublication(base, pub)
	}
	if ctx.Err() != nil {
		return base
	}
	s2ctx, s2cancel := context.WithTimeout(ctx, 2*time.Second)
	p, err := c.s2(s2ctx, "ARXIV:"+bareArXiv(base.ArXiv))
	s2cancel()
	if err == nil && p.ExternalIDs.ArXiv != "" && !strings.EqualFold(bareArXiv(p.ExternalIDs.ArXiv), bareArXiv(base.ArXiv)) {
		// A conflicting identifier must never enrich a different paper.
		err = ErrNotFound
	}
	if err != nil {
		logPublicationLookup(ctx, "semantic_scholar", Metadata{}, err)
		return base
	}
	pub := p.metadata()
	if !publicationVenue(pub.Venue) && p.Journal != nil && publicationVenue(p.Journal.Name) {
		pub.Venue = clean(p.Journal.Name)
	}
	logPublicationLookup(ctx, "semantic_scholar", pub, nil)
	if !strings.EqualFold(pub.DOI, base.DOI) {
		if canonical, ok := c.publicationCrossref(ctx, pub.DOI); ok {
			return mergeArxivPublication(base, canonical)
		}
	}
	if publishedMetadata(pub) {
		return mergeArxivPublication(base, pub)
	}
	return base
}
