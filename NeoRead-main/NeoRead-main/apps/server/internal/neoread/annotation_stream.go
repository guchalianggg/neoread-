package neoread

import (
	"fmt"
	"net/http"
	"time"
)

// Protected by annotationMu. Tokens change across server restarts as well as
// committed recovery/migration updates; they contain no annotation content.
func (s *Server) annotationRevision(document string) string {
	if s.annotationRevisions == nil {
		s.annotationRevisions = map[string]string{}
	}
	if s.annotationRevisions[document] == "" {
		s.annotationRevisions[document] = id()
	}
	return s.annotationRevisions[document]
}
func (s *Server) publishAnnotationChange(document string) {
	s.annotationRevision(document)
	s.annotationRevisions[document] = id()
	for ch := range s.annotationSubscribers[document] {
		select {
		case ch <- struct{}{}:
		default:
		} // Coalesce; readers fetch the latest revision.
	}
}
func (s *Server) streamAnnotationChanges(w http.ResponseWriter, r *http.Request) {
	document := r.PathValue("id")
	if _, err := s.Store.Document(document); err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	s.annotationMu.Lock()
	revision := s.annotationRevision(document)
	ch := make(chan struct{}, 1)
	if s.annotationSubscribers == nil {
		s.annotationSubscribers = map[string]map[chan struct{}]struct{}{}
	}
	if s.annotationSubscribers[document] == nil {
		s.annotationSubscribers[document] = map[chan struct{}]struct{}{}
	}
	s.annotationSubscribers[document][ch] = struct{}{}
	s.annotationMu.Unlock()
	defer func() {
		s.annotationMu.Lock()
		delete(s.annotationSubscribers[document], ch)
		if len(s.annotationSubscribers[document]) == 0 {
			delete(s.annotationSubscribers, document)
		}
		s.annotationMu.Unlock()
	}()
	controller := http.NewResponseController(w)
	defer controller.SetWriteDeadline(time.Time{})
	send := func(value string) error {
		_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if _, err := fmt.Fprintf(w, "event: revision\ndata: %q\n\n", value); err != nil {
			return err
		}
		return controller.Flush()
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	if send(revision) != nil {
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ch:
			s.annotationMu.Lock()
			revision = s.annotationRevision(document)
			s.annotationMu.Unlock()
			if send(revision) != nil {
				return
			}
		case <-heartbeat.C:
			if _, err := s.Store.Document(document); err != nil {
				return
			}
			_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			if controller.Flush() != nil {
				return
			}
		}
	}
}
