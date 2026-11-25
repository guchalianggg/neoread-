package neoread

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Server) postSourceSync(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	ctx := r.Context()
	phase := "validate"
	revision, err := s.syncDocumentSource(w, r, func(next string) { phase = next })
	w.Header().Set("Cache-Control", "no-store")
	if err == nil {
		if revision == 0 {
			// The HTTP diagnostic already records 204; avoid duplicate polling noise.
			w.WriteHeader(http.StatusNoContent)
			return
		}
		s.diagnosticEvent(slog.LevelInfo, "document.source_sync.finish", "requestId", requestID(ctx), "phase", phase, "outcome", "complete", "revision", revision, "durationMs", time.Since(started).Milliseconds())
		respond(w, http.StatusOK, struct {
			Revision int64 `json:"revision"`
		}{revision})
		return
	}
	outcome, level := "failed", slog.LevelError
	if ctx.Err() != nil {
		err = ctx.Err()
	}
	reason := sourceReason(err)
	if reason == "cancelled" {
		outcome, level = "cancelled", slog.LevelInfo
	}
	s.diagnosticEvent(level, "document.source_sync.finish", "requestId", requestID(ctx), "phase", phase, "outcome", outcome, "reasonCode", reason, "durationMs", time.Since(started).Milliseconds())
	sourceSyncFailure(w, err)
}

func sourceSyncFailure(w http.ResponseWriter, err error) {
	var e sourceConversionError
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		fail(w, http.StatusRequestTimeout, "同步已取消或超时，上一版本已保留")
	case errors.As(err, &e):
		switch e.code {
		case "conflict", "busy", "anchored":
			respond(w, http.StatusConflict, map[string]string{"error": e.message, "code": e.code})
		case "unavailable":
			fail(w, http.StatusNotFound, e.message)
		case "unsupported":
			fail(w, http.StatusUnsupportedMediaType, e.message)
		case "limit":
			fail(w, http.StatusRequestEntityTooLarge, e.message)
		case "dependency":
			fail(w, http.StatusServiceUnavailable, e.message)
		case "timeout":
			fail(w, http.StatusRequestTimeout, e.message)
		case "read", "write":
			fail(w, http.StatusInternalServerError, e.message)
		default:
			fail(w, http.StatusBadRequest, e.message)
		}
	default:
		fail(w, http.StatusInternalServerError, "无法同步源文件，上一版本已保留")
	}
}

func (s *Server) syncDocumentSource(w http.ResponseWriter, r *http.Request, setPhase func(string)) (int64, error) {
	ctx := r.Context()
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/octet-stream" {
		return 0, sourceError("unsupported", "请以 application/octet-stream 发送源文件字节")
	}
	documentID := r.PathValue("id")
	loadDocument := func() (Document, error) {
		d, err := scanDocument(s.Store.DB.QueryRowContext(ctx, `SELECT `+documentColumns+` FROM documents WHERE id=?`, documentID))
		if errors.Is(err, sql.ErrNoRows) || (err == nil && d.DeletedAt != "") {
			return d, sourceError("unavailable", "文档已不可用")
		}
		return d, err
	}
	d, err := loadDocument()
	if err != nil {
		return 0, err
	}
	var limit int64
	switch d.SourceFormat {
	case "md", "markdown":
		limit = markdownSourceLimit
	case "doc", "docx":
		limit = sourceResourceLimit
	default:
		return 0, sourceError("unsupported", "此文档不支持源文件同步")
	}
	if r.ContentLength > limit {
		return 0, sourceError("limit", "源文件超过同步尺寸上限")
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	data, err := io.ReadAll(sourceContextReader{ctx, r.Body})
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return 0, sourceError("limit", "源文件超过同步尺寸上限")
	}
	if err != nil || (r.ContentLength >= 0 && r.ContentLength != int64(len(data))) {
		return 0, sourceError("validation", "源文件传输未完成")
	}
	hash := sha256.Sum256(data)
	digest := hex.EncodeToString(hash[:])

	setPhase("eligibility")
	if !s.importMu.TryLock() {
		return 0, sourceError("busy", "书库正在处理文档，请稍后重试同步")
	}
	defer s.importMu.Unlock()
	// The upload did not hold the import lock. In particular, a purge/reimport
	// during upload can create the same content ID for a different document.
	current, err := loadDocument()
	if err != nil {
		return 0, err
	}
	if current.CreatedAt != d.CreatedAt || current.SourceFormat != d.SourceFormat || current.Type != d.Type {
		return 0, sourceError("unavailable", "文档已不可用")
	}
	var filename, lastDigest string
	var editorRevision, lastRevision int64
	err = s.Store.DB.QueryRowContext(ctx, `SELECT a.filename, COALESCE(e.revision,0), COALESCE(s.revision,?), COALESCE(s.sha256,a.sha256)
FROM paper_attachments a LEFT JOIN source_edits e ON e.document_id=a.document_id LEFT JOIN source_syncs s ON s.document_id=a.document_id
WHERE a.document_id=? AND a.kind='file' AND substr(a.sha256,1,32)=a.document_id LIMIT 1`, sourceEditInitialRevision, current.ID).Scan(&filename, &editorRevision, &lastRevision, &lastDigest)
	if err != nil {
		return 0, err
	}
	// An uninitialized editor still represents the import (revision 1). Check
	// for a Reader save before comparing digests: those bytes are no longer current.
	if max(editorRevision, sourceEditInitialRevision) != lastRevision {
		return 0, sourceError("conflict", "阅读器已有保存的本地修改，未覆盖当前版本")
	}
	if digest == lastDigest {
		return 0, nil
	}
	finish, err := s.beginSourcePublication(current)
	if err != nil {
		return 0, err
	}
	defer finish()

	setPhase("prepare")
	s.diagnosticEvent(slog.LevelInfo, "document.source_sync.start", "requestId", requestID(ctx), "phase", "prepare", "format", current.SourceFormat)
	text, err := sourceSyncText(s.sourceDiagnosticContext(ctx), current.SourceFormat, data)
	if err != nil {
		return 0, err
	}
	next := initialSourceEditSnapshot(current, filename)
	next.Revision = lastRevision + 1
	next.Content = &text
	version, texts, err := s.prepareSourceVersion(ctx, current, next, true)
	if err != nil {
		return 0, err
	}
	setPhase("publish")
	if err := s.publishSourceVersion(ctx, current, next, editorRevision, version, texts, digest); err != nil {
		return 0, err
	}
	return next.Revision, nil
}

func sourceSyncText(ctx context.Context, kind string, data []byte) (string, error) {
	if kind == "md" || kind == "markdown" {
		return strings.TrimPrefix(string(data), "\ufeff"), nil
	}
	// Extensions come only from the stored original. Never use a caller path
	// (or the original attachment) as converter input or output.
	work, err := os.MkdirTemp("", "neoread-source-sync-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	input := filepath.Join(work, "input."+kind)
	if err := os.WriteFile(input, data, 0600); err != nil {
		return "", err
	}
	return wordMarkdown(ctx, input, kind)
}
