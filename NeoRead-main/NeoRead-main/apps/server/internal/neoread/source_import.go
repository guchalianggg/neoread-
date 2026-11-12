package neoread

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Source format is inferred from the immutable original's full hash, not from
// Document.Type (which intentionally stays epub). An unrelated EPUB attachment
// cannot grant a normal EPUB admission to the papers library.
func (s *Store) sourceDocumentKind(d Document) string {
	if d.Type != "epub" {
		return ""
	}
	var filename string
	if s.DB.QueryRow("SELECT filename FROM paper_attachments WHERE document_id=? AND kind='file' AND substr(sha256,1,32)=? LIMIT 1", d.ID, d.ID).Scan(&filename) != nil {
		return ""
	}
	kind := strings.TrimPrefix(strings.ToLower(filepath.Ext(filename)), ".")
	if auxiliarySource(kind) {
		return kind
	}
	return ""
}

func (s *Server) sourceReadingCopy(ctx context.Context, source, kind, title, hash string) (string, error) {
	ctx = s.sourceDiagnosticContext(ctx)
	started := time.Now()
	s.diagnosticEvent(slog.LevelInfo, "document.source_conversion.start", "requestId", requestID(ctx), "phase", kind)
	f, err := os.CreateTemp(s.Store.Root, "source-*.epub")
	if err == nil {
		err = convertSource(ctx, source, kind, title, hash, f)
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
	}
	if err != nil {
		if f != nil {
			_ = os.Remove(f.Name())
		}
		level := slog.LevelError
		if ctx.Err() != nil {
			level = slog.LevelInfo
			err = sourceError("cancelled", "导入已取消")
		}
		s.diagnosticEvent(level, "document.source_conversion.failed", "requestId", requestID(ctx), "phase", kind, "reasonCode", sourceReason(err), "durationMs", time.Since(started).Milliseconds())
		var e sourceConversionError
		if !errors.As(err, &e) {
			err = sourceError("write", "无法生成本地 EPUB 阅读副本")
		}
		return "", err
	}
	s.diagnosticEvent(slog.LevelInfo, "document.source_conversion.finish", "requestId", requestID(ctx), "phase", kind, "durationMs", time.Since(started).Milliseconds())
	return f.Name(), nil
}

func sourceAttachment(d Document, filename, hash string) (PaperAttachment, error) {
	filename = strings.TrimSpace(filepath.Base(strings.ReplaceAll(filename, "\\", "/")))
	if !validAttachmentTitle(filename) || filename == "." || filename == ".." {
		return PaperAttachment{}, errors.New("原件文件名无效或超过 255 个字符")
	}
	mediaType := mime.TypeByExtension(strings.ToLower(filepath.Ext(filename)))
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	return PaperAttachment{ID: id(), DocumentID: d.ID, Kind: "file", Title: filename, Filename: filename, MediaType: mediaType, Size: d.Size, CreatedAt: d.CreatedAt, Hash: hash}, nil
}

// The caller holds importMu and writes this row in the document transaction.
// rollback must happen before cleanupAttachmentFile (DB uses one connection).
func insertSourceAttachment(ctx context.Context, tx *sql.Tx, a PaperAttachment) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO paper_attachments(id,document_id,kind,title,filename,media_type,size,url,created_at,sha256) VALUES(?,?,?,?,?,?,?,?,?,?)`, a.ID, a.DocumentID, a.Kind, a.Title, a.Filename, a.MediaType, a.Size, a.URL, a.CreatedAt, a.Hash)
	return err
}
