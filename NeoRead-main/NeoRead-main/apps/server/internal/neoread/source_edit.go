package neoread

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/xuri/excelize/v2"
)

// Limits are rejection boundaries, never truncation. Rectangular cell budgets
// include holes, per sheet and across all sheets. All cells are literal strings.
const (
	sourceEditRequestLimit = 16 << 20
	sourceEditTextLimit    = 8 << 20
	sourceEditCellLimit    = 32767 // UTF-16 units, Excel's native limit
)

type sourceEditSheet struct {
	Name string     `json:"name"`
	Rows [][]string `json:"rows"`
}
type sourceEditSnapshot struct {
	Kind     string            `json:"kind"`
	Filename string            `json:"filename"`
	Revision int64             `json:"revision"`
	Content  *string           `json:"content,omitempty"`
	Sheets   []sourceEditSheet `json:"sheets,omitempty"`
	Editable bool              `json:"editable"`
}
type sourceEditRequest struct {
	Revision *int64             `json:"revision"`
	Content  *string            `json:"content,omitempty"`
	Sheets   *[]sourceEditSheet `json:"sheets,omitempty"`
}

func sourceFilenameKind(filename string) string {
	kind := strings.TrimPrefix(strings.ToLower(filepath.Ext(filename)), ".")
	if auxiliarySource(kind) {
		return kind
	}
	return ""
}
func sourceEditExtension(kind string) string {
	switch kind {
	case "xls":
		return "xlsx"
	case "doc":
		return "docx"
	}
	return kind
}
func (s *Store) sourceVersionDir(document, version string) string {
	return filepath.Join(s.Root, "cache", document, "source-edits", version)
}
func (s *Store) sourceEditVersion(document string) (string, bool) {
	var version string
	var reading bool
	err := s.DB.QueryRow("SELECT version,reading FROM source_edits WHERE document_id=?", document).Scan(&version, &reading)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false
	}
	// Never silently fall back to the original on a corrupt row or DB failure.
	if err != nil {
		return "unavailable", true
	}
	if raw, err := hex.DecodeString(version); err != nil || len(raw) != 16 {
		return "unavailable", true
	}
	return version, reading
}
func (s *Store) documentCache(document string) string {
	if version, reading := s.sourceEditVersion(document); reading {
		return filepath.Join(s.sourceVersionDir(document, version), "publication")
	}
	return filepath.Join(s.Root, "cache", document)
}

func validSourceEditText(text string) bool {
	return utf8.ValidString(text) && !strings.ContainsFunc(text, func(r rune) bool {
		return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' || r == 0xfffe || r == 0xffff
	})
}
func validateSourceSnapshot(ctx context.Context, snap sourceEditSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if snap.Kind != "xls" && snap.Kind != "xlsx" {
		if snap.Content == nil || len(snap.Sheets) != 0 || !validSourceEditText(*snap.Content) {
			return sourceError("validation", "正文必须是有效 UTF-8 文本，不能包含控制字符或工作表")
		}
		if len(*snap.Content) > sourceEditTextLimit {
			return sourceError("limit", "正文超过 8 MiB 保存上限")
		}
		return nil
	}
	if snap.Content != nil || len(snap.Sheets) < 1 || len(snap.Sheets) > sourceMaxSheets {
		return sourceError("validation", "Excel 必须包含 1–64 个工作表，不能同时提交正文")
	}
	budget, textBytes := 0, 0
	names := map[string]bool{}
	for _, sheet := range snap.Sheets {
		if err := ctx.Err(); err != nil {
			return err
		}
		key := strings.ToLower(sheet.Name)
		if sheet.Name == "" || utf8.RuneCountInString(sheet.Name) > 31 || !validSourceEditText(sheet.Name) || strings.ContainsAny(sheet.Name, ":\\/?*[]\r\n\t") || strings.HasPrefix(sheet.Name, "'") || strings.HasSuffix(sheet.Name, "'") || names[key] {
			return sourceError("validation", "工作表名称须为 1–31 个字符、互不重复，且不能包含 Excel 禁止字符")
		}
		names[key] = true
		if sheet.Rows == nil {
			return sourceError("validation", "每个工作表必须提供 rows 数组，空表请使用 []")
		}
		maxCol := 0
		if len(sheet.Rows) > sourceMaxRows {
			return sourceTableLimit()
		}
		for _, row := range sheet.Rows {
			if row == nil {
				return sourceError("validation", "每一行必须为字符串数组，空行请使用 []")
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			maxCol = max(maxCol, len(row))
			if maxCol > sourceMaxColumns {
				return sourceTableLimit()
			}
			for _, value := range row {
				if !validSourceEditText(value) {
					return sourceError("validation", "单元格包含无效字符")
				}
				if utf16Length(value) > sourceEditCellLimit {
					return sourceError("limit", "单元格超过 32767 个 UTF-16 字符上限")
				}
				textBytes += len(value)
				if textBytes > sourceEditTextLimit {
					return sourceError("limit", "全部单元格文本超过 8 MiB 上限")
				}
			}
		}
		budget += len(sheet.Rows) * maxCol
		if budget > sourceMaxCells {
			return sourceTableLimit()
		}
	}
	return nil
}
func sourceSheetChapters(ctx context.Context, sheets []sourceEditSheet, allowEmpty bool) ([]sourceChapter, error) {
	budget, nonempty := 0, false
	var chapters []sourceChapter
	for _, sheet := range sheets {
		chapter, hasText, err := sourceTable(ctx, sheet.Name, sheet.Rows, &budget)
		if err != nil {
			return nil, err
		}
		nonempty = nonempty || hasText
		chapters = append(chapters, chapter)
	}
	if !nonempty && !allowEmpty {
		return nil, sourceError("empty", "Excel 所有工作表均为空，没有可阅读的单元格")
	}
	return chapters, nil
}

func writeEditableFile(ctx context.Context, path string, snap sourceEditSnapshot) error {
	if err := validateSourceSnapshot(ctx, snap); err != nil {
		return err
	}
	switch snap.Kind {
	case "md", "markdown":
		return os.WriteFile(path, []byte(*snap.Content), 0600)
	case "doc", "docx":
		canonical, err := writeWordFile(ctx, *snap.Content, path)
		if err == nil {
			*snap.Content = canonical
		}
		return err
	default:
		book := excelize.NewFile()
		defer book.Close()
		// Rename the default to a private temporary name first, so a later
		// user sheet named Sheet1 cannot collide with it.
		temp := "_neoread_" + id()[:16]
		if err := book.SetSheetName("Sheet1", temp); err != nil {
			return err
		}
		for i, sheet := range snap.Sheets {
			var err error
			if i == 0 {
				err = book.SetSheetName(temp, sheet.Name)
			} else {
				_, err = book.NewSheet(sheet.Name)
			}
			if err != nil {
				return sourceError("validation", "工作表名称无效")
			}
			for r, row := range sheet.Rows {
				if err = ctx.Err(); err != nil {
					return err
				}
				for c, value := range row {
					cell, _ := excelize.CoordinatesToCellName(c+1, r+1)
					// Never SetCellFormula/CalcCellValue, even for '=...' input.
					if err = book.SetCellStr(sheet.Name, cell, value); err != nil {
						return sourceError("write", "无法写入 Excel 单元格")
					}
				}
			}
		}
		if err := book.SaveAs(path); err != nil {
			return sourceError("write", "无法生成 XLSX 可编辑副本")
		}
		return ctx.Err()
	}
}

// Build a new immutable generation completely before publishing its DB pointer.
// Old generations remain available to readers until document purge. A crash
// before commit can leave an unreferenced generation, never a partial saved draft.
func (s *Server) prepareSourceVersion(ctx context.Context, d Document, snap sourceEditSnapshot, reading bool) (version string, texts map[string]string, err error) {
	ctx = s.sourceDiagnosticContext(ctx)
	version = id()
	dir := s.Store.sourceVersionDir(d.ID, version)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(dir)
		}
	}()
	path := filepath.Join(dir, "source."+sourceEditExtension(snap.Kind))
	if err = writeEditableFile(ctx, path, snap); err != nil {
		return
	}
	if reading {
		var chapters []sourceChapter
		var toc []sourceTOC
		if snap.Content != nil {
			// The exported source remains really empty. Only the reading copy
			// substitutes a placeholder for empty or non-rendering Markdown.
			mdPath := filepath.Join(dir, "reading.md")
			err = os.WriteFile(mdPath, []byte(*snap.Content), 0600)
			if err != nil {
				return
			}
			chapters, toc, err = markdownChapters(ctx, mdPath, d.Title)
			if sourceReason(err) == "empty" {
				chapters, toc, err = []sourceChapter{{d.Title, "<p>空文档</p>"}}, nil, nil
			}
			_ = os.Remove(mdPath)
		} else {
			chapters, err = sourceSheetChapters(ctx, snap.Sheets, true)
		}
		if err != nil {
			return
		}
		if len(toc) == 0 {
			for i, c := range chapters {
				toc = append(toc, sourceTOC{c.title, "chapter-" + strconv.Itoa(i+1) + ".xhtml"})
			}
		}
		var f *os.File
		f, err = os.Create(filepath.Join(dir, "reading.epub"))
		if err != nil {
			return
		}
		err = writeSourceEPUB(ctx, f, d.Title, d.ID+"-"+version, chapters, toc)
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return
		}
		_, texts, err = prepareEPUB(ctx, filepath.Join(dir, "reading.epub"), filepath.Join(dir, "publication"))
		if err != nil {
			return
		}
	}
	err = filepath.WalkDir(dir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if e := ctx.Err(); e != nil {
			return e
		}
		if entry.IsDir() {
			return nil
		}
		f, e := os.OpenFile(path, os.O_RDWR, 0600)
		if e != nil {
			return e
		}
		e = f.Sync()
		closeErr := f.Close()
		if e == nil {
			e = closeErr
		}
		return e
	})
	return
}

// Caller holds importMu; originals are immutable, and repeated import does not
// run this initializer again. Recovery bounds also protect the legacy BIFF reader.
func (s *Server) sourceSnapshot(ctx context.Context, d Document) (snap sourceEditSnapshot, err error) {
	ctx = s.sourceDiagnosticContext(ctx)
	initializing := false
	started := time.Now()
	defer func() {
		if recover() != nil {
			err = sourceError("corrupt", "源文件损坏，无法初始化可编辑副本")
		}
		if initializing {
			outcome, level := "complete", slog.LevelInfo
			if err != nil {
				outcome, level = "failed", slog.LevelError
				if ctx.Err() != nil {
					outcome, level = "cancelled", slog.LevelInfo
				}
			}
			s.diagnosticEvent(level, "document.source_edit.finish", "requestId", requestID(ctx), "phase", "initialize", "outcome", outcome, "reasonCode", sourceReason(err), "durationMs", time.Since(started).Milliseconds())
		}
	}()
	var body string
	err = s.Store.DB.QueryRowContext(ctx, "SELECT body FROM source_edits WHERE document_id=?", d.ID).Scan(&body)
	if err == nil {
		err = json.Unmarshal([]byte(body), &snap)
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return
	}
	initializing = true
	s.diagnosticEvent(slog.LevelInfo, "document.source_edit.start", "requestId", requestID(ctx), "phase", "initialize")
	var filename, hash string
	err = s.Store.DB.QueryRowContext(ctx, "SELECT filename,sha256 FROM paper_attachments WHERE document_id=? AND kind='file' AND substr(sha256,1,32)=? LIMIT 1", d.ID, d.ID).Scan(&filename, &hash)
	if err != nil {
		return
	}
	if b, e := hex.DecodeString(hash); e != nil || len(b) != 32 {
		return snap, sourceError("corrupt", "原件记录无效")
	}
	snap = sourceEditSnapshot{Kind: d.SourceFormat, Filename: strings.TrimSuffix(filename, filepath.Ext(filename)) + "." + sourceEditExtension(d.SourceFormat), Revision: 1, Editable: true}
	original := filepath.Join(s.Store.Root, "attachments", hash)
	switch snap.Kind {
	case "md", "markdown":
		var data []byte
		data, err = readSourceBounded(ctx, original, sourceEditTextLimit)
		if err == nil {
			text := strings.TrimPrefix(string(data), "\ufeff")
			snap.Content = &text
		}
	case "doc", "docx":
		var text string
		text, err = wordMarkdown(ctx, original, snap.Kind)
		if err == nil {
			snap.Content = &text
		}
	case "xls":
		snap.Sheets, err = readXLSSheets(ctx, original)
	case "xlsx":
		snap.Sheets, err = readXLSXSheets(ctx, original)
	default:
		err = sourceError("format", "文档不支持源文件编辑")
	}
	if err != nil {
		return
	}
	var version string
	version, _, err = s.prepareSourceVersion(ctx, d, snap, false)
	if err != nil {
		return
	}
	raw, _ := json.Marshal(snap)
	_, err = s.Store.DB.ExecContext(ctx, "INSERT INTO source_edits(document_id,revision,body,version,reading) VALUES(?,?,?,?,0)", d.ID, snap.Revision, string(raw), version)
	if err != nil {
		_ = os.RemoveAll(s.Store.sourceVersionDir(d.ID, version))
	}
	return
}
func readSourceBounded(ctx context.Context, path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, sourceError("read", "无法读取源文件")
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(sourceContextReader{ctx, f}, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, sourceError("limit", "源文件超过转换或编辑尺寸上限")
	}
	return data, nil
}
func (s *Server) sourceEditDocument(w http.ResponseWriter, r *http.Request) (Document, bool) {
	d, err := s.Store.Document(r.PathValue("id"))
	if err != nil || d.DeletedAt != "" || d.SourceFormat == "" {
		fail(w, 404, "文档不支持源文件编辑或已不可用")
		return d, false
	}
	return d, true
}
func (s *Server) sourceEditFailure(w http.ResponseWriter, r *http.Request, err error) {
	status, message := 500, "可编辑副本保存或读取失败，上一版本已保留"
	var e sourceConversionError
	if errors.As(err, &e) {
		message = e.message
		switch e.code {
		case "limit":
			status = 413
		case "conflict", "anchored", "busy":
			status = 409
		case "dependency":
			status = 503
		default:
			status = 400
		}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		status, message = 408, "编辑操作已取消或超时，上一版本已保留"
	}
	fail(w, status, message)
}
func (s *Server) getSourceEdit(w http.ResponseWriter, r *http.Request) {
	s.importMu.Lock()
	defer s.importMu.Unlock()
	d, ok := s.sourceEditDocument(w, r)
	if !ok {
		return
	}
	ctx, finish, err := s.beginDocumentTask(r.Context(), d.ID)
	if err != nil {
		s.sourceEditFailure(w, r, sourceError("busy", "文档正在处理，请稍后重试"))
		return
	}
	defer finish()
	snap, err := s.sourceSnapshot(ctx, d)
	if err != nil {
		s.sourceEditFailure(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	respond(w, 200, snap)
}
func (s *Server) downloadSourceEdit(w http.ResponseWriter, r *http.Request) {
	s.importMu.Lock()
	defer s.importMu.Unlock()
	d, ok := s.sourceEditDocument(w, r)
	if !ok {
		return
	}
	ctx, finish, err := s.beginDocumentTask(r.Context(), d.ID)
	if err != nil {
		s.sourceEditFailure(w, r, sourceError("busy", "文档正在处理，请稍后重试"))
		return
	}
	defer finish()
	snap, err := s.sourceSnapshot(ctx, d)
	if err != nil {
		s.sourceEditFailure(w, r, err)
		return
	}
	version, _ := s.Store.sourceEditVersion(d.ID)
	path := filepath.Join(s.Store.sourceVersionDir(d.ID, version), "source."+sourceEditExtension(snap.Kind))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": snap.Filename}))
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, path)
}
func (s *Server) putSourceEdit(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	s.diagnosticEvent(slog.LevelInfo, "document.source_edit.start", "requestId", requestID(r.Context()), "phase", "save")
	var operationErr error
	defer func() {
		outcome, level := "complete", slog.LevelInfo
		if operationErr != nil {
			outcome, level = "failed", slog.LevelError
			if r.Context().Err() != nil {
				outcome, level = "cancelled", slog.LevelInfo
			}
		}
		reason := "complete"
		if operationErr != nil {
			reason = sourceReason(operationErr)
		}
		s.diagnosticEvent(level, "document.source_edit.finish", "requestId", requestID(r.Context()), "phase", "save", "outcome", outcome, "reasonCode", reason, "durationMs", time.Since(started).Milliseconds())
	}()
	reject := func(err error) { operationErr = err; s.sourceEditFailure(w, r, err) }
	r.Body = http.MaxBytesReader(w, r.Body, sourceEditRequestLimit)
	data, err := io.ReadAll(sourceContextReader{r.Context(), r.Body})
	if err != nil {
		if r.Context().Err() != nil {
			reject(r.Context().Err())
		} else {
			reject(sourceError("limit", "请求超过 16 MiB 或传输未完成"))
		}
		return
	}
	var input sourceEditRequest
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if !validSourceEditJSON(data) || dec.Decode(&input) != nil || dec.Decode(new(any)) != io.EOF || input.Revision == nil || *input.Revision < 1 {
		reject(sourceError("validation", "请求须为单个 JSON 对象，并包含有效 revision"))
		return
	}
	if input.Content != nil && input.Sheets != nil {
		reject(sourceError("validation", "正文与工作表不能同时提交"))
		return
	}
	s.importMu.Lock()
	defer s.importMu.Unlock()
	d, ok := s.sourceEditDocument(w, r)
	if !ok {
		operationErr = sourceError("format", "不适用")
		return
	}
	finish, err := s.beginDocumentReparse(d)
	if err != nil {
		reject(sourceError("busy", "文档正在处理，请稍后重试保存"))
		return
	}
	defer finish()
	// Do not delete or relocate positional user data. This deliberately rejects
	// old reader records; the source editor does not create positional marks.
	s.annotationMu.Lock()
	defer s.annotationMu.Unlock()
	if !s.corpusMu.TryLock() {
		reject(sourceError("busy", "全文索引正在准备，请稍后重试保存"))
		return
	}
	defer s.corpusMu.Unlock()
	old, err := s.sourceSnapshot(r.Context(), d)
	if err != nil {
		reject(err)
		return
	}
	if old.Revision != *input.Revision {
		reject(sourceError("conflict", "文档已被其他编辑器保存，请重新加载后再保存"))
		return
	}
	next := old
	next.Revision++
	next.Content = input.Content
	next.Sheets = nil
	if input.Sheets != nil {
		next.Sheets = *input.Sheets
	}
	if err = validateSourceSnapshot(r.Context(), next); err != nil {
		reject(err)
		return
	}
	version, texts, err := s.prepareSourceVersion(r.Context(), d, next, true)
	if err != nil {
		reject(err)
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(s.Store.sourceVersionDir(d.ID, version))
		}
	}()
	tx, err := s.Store.DB.BeginTx(r.Context(), nil)
	if err != nil {
		reject(err)
		return
	}
	defer tx.Rollback()
	var anchored bool
	err = tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM annotations WHERE document_id=?) OR EXISTS(SELECT 1 FROM document_navigation WHERE document_id=?) OR COALESCE(progress,'') NOT IN ('','null') OR percentage>0 FROM documents WHERE id=?`, d.ID, d.ID, d.ID).Scan(&anchored)
	if err != nil {
		reject(err)
		return
	}
	if anchored {
		reject(sourceError("anchored", "此文档已有阅读位置、定位批注或自定义目录，暂不支持自动迁移；请保留此文档并将当前可编辑版作为新文档导入"))
		return
	}
	raw, _ := json.Marshal(next)
	result, err := tx.ExecContext(r.Context(), "UPDATE source_edits SET revision=?,body=?,version=?,reading=1 WHERE document_id=? AND revision=?", next.Revision, string(raw), version, d.ID, old.Revision)
	if err != nil {
		reject(err)
		return
	}
	if n, _ := result.RowsAffected(); n != 1 {
		reject(sourceError("conflict", "文档版本已变化，请重新加载"))
		return
	}
	for _, table := range []string{"search_index", "document_corpora", "document_passages_fts", "document_overviews_fts"} {
		if _, err = tx.ExecContext(r.Context(), "DELETE FROM "+table+" WHERE document_id=?", d.ID); err != nil {
			reject(err)
			return
		}
	}
	for href, text := range texts {
		if _, err = tx.ExecContext(r.Context(), "INSERT INTO search_index(document_id,href,content) VALUES(?,?,?)", d.ID, href, text); err != nil {
			reject(err)
			return
		}
	}
	if _, err = tx.ExecContext(r.Context(), "INSERT INTO document_corpus_jobs(document_id,status) VALUES(?,'queued') ON CONFLICT(document_id) DO UPDATE SET status='queued'", d.ID); err != nil {
		reject(err)
		return
	}
	if err = tx.Commit(); err != nil {
		reject(err)
		return
	}
	committed = true
	s.codexChat.deleteDocument(d.ID)
	s.documentCodex.deleteDocument(d.ID)
	s.connectorRevision.Add(1)
	w.Header().Set("Cache-Control", "no-store")
	respond(w, 200, next)
}

type sourceDiagnosticKey struct{}

func (s *Server) sourceDiagnosticContext(ctx context.Context) context.Context {
	return context.WithValue(ctx, sourceDiagnosticKey{}, s)
}
func sourceConversionStage(ctx context.Context, tool, phase string) func(error) {
	s, _ := ctx.Value(sourceDiagnosticKey{}).(*Server)
	if s == nil {
		return func(error) {}
	}
	started := time.Now()
	s.diagnosticEvent(slog.LevelInfo, "document.source_process.start", "requestId", requestID(ctx), "tool", tool, "phase", phase)
	return func(err error) {
		outcome, level, reason := "complete", slog.LevelInfo, "complete"
		if err != nil {
			outcome, level, reason = "failed", slog.LevelError, sourceReason(err)
		}
		if ctx.Err() != nil {
			outcome, level = "cancelled", slog.LevelInfo
		}
		s.diagnosticEvent(level, "document.source_process.finish", "requestId", requestID(ctx), "tool", tool, "phase", phase, "outcome", outcome, "reasonCode", reason, "durationMs", time.Since(started).Milliseconds())
	}
}

// JSON's permissive null-to-string and lone-surrogate replacement would silently
// alter cell data. Reject them, duplicate keys and excessive nesting up front.
func validSourceEditJSON(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	for i := 0; i < len(data); i++ {
		if data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) {
			return false
		}
		if data[i] != 'u' {
			continue
		}
		if i+4 >= len(data) {
			return false
		}
		n, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if n >= 0xd800 && n <= 0xdbff {
			if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
				return false
			}
			low, e := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
			if e != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		} else if n >= 0xdc00 && n <= 0xdfff {
			return false
		}
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var consume func(int) bool
	consume = func(depth int) bool {
		if depth > 8 {
			return false
		}
		token, err := d.Token()
		if err != nil || token == nil {
			return false
		}
		if delim, ok := token.(json.Delim); ok {
			switch delim {
			case '{':
				seen := map[string]bool{}
				for d.More() {
					key, e := d.Token()
					name, ok := key.(string)
					if e != nil || !ok || seen[name] {
						return false
					}
					seen[name] = true
					if !consume(depth + 1) {
						return false
					}
				}
				end, e := d.Token()
				return e == nil && end == json.Delim('}')
			case '[':
				for d.More() {
					if !consume(depth + 1) {
						return false
					}
				}
				end, e := d.Token()
				return e == nil && end == json.Delim(']')
			default:
				return false
			}
		}
		return true
	}
	if !consume(0) {
		return false
	}
	_, err := d.Token()
	return err == io.EOF
}

// Source editors intentionally do not share the old reader's unversioned
// location protocol. Existing records block save; stale clients cannot add new
// old-reader anchors after the generation switch either.
func (s *Server) sourcePositionBlocked(w http.ResponseWriter, d Document) bool {
	if d.SourceFormat != "" {
		if _, edited := s.Store.sourceEditVersion(d.ID); edited {
			fail(w, 409, "源文件编辑稿不支持旧阅读器的定位批注、阅读位置或自定义目录")
			return true
		}
	}
	return false
}
func (s *Server) guardSourceNavigation(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.annotationMu.Lock()
		defer s.annotationMu.Unlock()
		if d, err := s.Store.Document(r.PathValue("id")); err == nil && s.sourcePositionBlocked(w, d) {
			return
		}
		next(w, r)
	}
}
