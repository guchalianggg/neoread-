package neoread

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/mail"
	"os"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"rsc.io/pdf"
)

// Classification confirmation is independent of the transport safety bound.
const (
	maxImportBytes = 512 << 20 // Transport/download safety bound, not a paper classification limit.
	// Papers both longer and larger than this ask whether to import as a
	// book, translated by chapter.
	largePaperPages = 100
)

// A variable so tests can use small files.
var largePaperBytes int64 = 100 << 20

// largePaper reports whether a PDF needs confirmation before entering the
// papers library. Without a readable page count, size alone decides.
func largePaper(pages int, size int64) bool {
	if pages <= 0 {
		return size > largePaperBytes
	}
	return pages > largePaperPages && size > largePaperBytes
}

func validLibrary(library string) bool { return library == "books" || library == "papers" }

func validImportFolder(folder string) bool {
	if utf8.RuneCountInString(folder) > 40 || strings.ContainsFunc(folder, unicode.IsControl) {
		return false
	}
	for _, part := range strings.Split(folder, "/") {
		if part == "" || part != strings.TrimSpace(part) {
			return false
		}
	}
	return true
}

// Resolve smart category rules on the server so imports use the saved tags.
// The returned tags are inserted in the same transaction as a new document.
func (s *Server) importCategoryTags(library, folder, smartID string) ([]string, error) {
	if (folder != "" || smartID != "") && library != "papers" ||
		folder != "" && (!validImportFolder(folder) || smartID != "") {
		return nil, errors.New("目标分类无效")
	}
	if smartID == "" {
		return []string{}, nil
	}
	var raw string
	if err := s.Store.DB.QueryRow("SELECT value FROM settings WHERE key='preferences:library'").Scan(&raw); err != nil {
		return nil, errors.New("无法读取智能标签分类，请重新选择")
	}
	var prefs struct {
		Papers struct {
			SmartCategories []struct {
				ID   string          `json:"id"`
				Tags json.RawMessage `json:"tags"`
			} `json:"smartCategories"`
		} `json:"papers"`
	}
	if json.Unmarshal([]byte(raw), &prefs) == nil {
		for _, category := range prefs.Papers.SmartCategories {
			if category.ID != smartID {
				continue
			}
			tags, err := normalizeTags(category.Tags)
			if err != nil || len(tags) == 0 {
				return nil, errors.New("智能标签分类的标签无效，请重新设置")
			}
			return tags, nil
		}
	}
	return nil, errors.New("智能标签分类已不存在，请重新选择")
}

// pdfPageCount reads the page tree without rendering. Malformed or unsupported
// encrypted files report an error instead of a guess.
func pdfPageCount(path string) (pages int, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	defer func() {
		// The parser panics on some malformed objects.
		if recover() != nil {
			pages, err = 0, errors.New("malformed PDF")
		}
	}()
	r, err := pdf.NewReader(f, info.Size())
	if err != nil {
		return 0, err
	}
	pages = r.NumPage()
	if pages < 1 {
		return 0, errors.New("PDF has no pages")
	}
	return pages, nil
}

// Paper PDFs and research-summary sources are allowed; direct EPUBs remain books-only.
func paperLimit(kind string, size int64, path string) string {
	if kind != "pdf" && !auxiliarySource(kind) {
		return "论文库支持 PDF、Markdown 和 Excel；EPUB 请导入图书库"
	}

	return ""
}

// "guide" records the finished onboarding and the last release notes shown.
// "fonts" caches installed font family names read by the renderer, so the
// font pickers need not query the system again after a restart.
var preferenceKeys = map[string]bool{"library": true, "guide": true, "shortcuts": true, "fonts": true}

func (s *Server) preferences(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	if !preferenceKeys[key] {
		s.sourceReadingPreferences(w, r, key)
		return
	}
	var value string
	err := s.Store.DB.QueryRow("SELECT value FROM settings WHERE key=?", "preferences:"+key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		respond(w, 200, map[string]any{})
		return
	}
	if err != nil {
		fail(w, 500, "无法读取偏好")
		return
	}
	respond(w, 200, json.RawMessage(value))
}
func (s *Server) savePreferences(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	if !preferenceKeys[key] {
		s.sourceReadingPreferences(w, r, key)
		return
	}
	var v map[string]any
	if !decode(w, r, &v) {
		return
	}
	if key == "library" {
		if raw, exists := v["crossrefEmail"]; exists {
			email, ok := raw.(string)
			email = strings.TrimSpace(email)
			if !ok || len(email) > 254 {
				fail(w, 400, "请填写有效的 Crossref 联系邮箱")
				return
			}
			if email != "" {
				address, err := mail.ParseAddress(email)
				if err != nil || address.Address != email {
					fail(w, 400, "请填写有效的 Crossref 联系邮箱")
					return
				}
			}
			v["crossrefEmail"] = email
		}
	}
	limit := 64 << 10
	if key == "fonts" {
		if msg := validFontPreferences(v); msg != "" {
			fail(w, 400, msg)
			return
		}
		limit = 512 << 10
	}
	b, _ := json.Marshal(v)
	if len(b) > limit {
		fail(w, 400, "偏好内容过大")
		return
	}
	if _, err := s.Store.DB.Exec("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", "preferences:"+key, string(b)); err != nil {
		fail(w, 500, "偏好保存失败")
		return
	}
	respond(w, 200, json.RawMessage(b))
}

const (
	sourceReadingPreferencePrefix = "source-reading-"
	sourceReadingPreferenceLimit  = 4 << 10
)

var sourceReadingPreferenceKey = regexp.MustCompile(`^` + sourceReadingPreferencePrefix + `[0-9a-f]{32}$`)

func (s *Server) sourceReadingPreferences(w http.ResponseWriter, r *http.Request, key string) {
	if !sourceReadingPreferenceKey.MatchString(key) {
		fail(w, 404, "未知偏好")
		return
	}
	var body json.RawMessage
	if r.Method == http.MethodPut {
		body = decodeSourceReadingPreferences(w, r)
		if body == nil {
			return
		}
	}

	// Check the original attachment and access settings in one transaction,
	// so a concurrent trash or purge cannot invalidate the check before a save.
	ctx := r.Context()
	tx, err := s.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		fail(w, 500, "无法访问阅读偏好")
		return
	}
	defer tx.Rollback()
	var filename, value string
	settingsKey := "preferences:" + key
	err = tx.QueryRowContext(ctx, `SELECT COALESCE((SELECT filename FROM paper_attachments
		WHERE document_id=documents.id AND kind='file' AND substr(sha256,1,32)=documents.id LIMIT 1),''),
		COALESCE((SELECT value FROM settings WHERE key=?),'{}')
		FROM documents WHERE id=? AND type='epub' AND deleted_at=''`, settingsKey, key[len(sourceReadingPreferencePrefix):]).Scan(&filename, &value)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		fail(w, 500, "无法读取阅读偏好")
		return
	}
	switch sourceFilenameKind(filename) {
	case "md", "markdown", "doc", "docx":
	default:
		fail(w, 404, "文档不存在或不支持原文阅读偏好")
		return
	}
	if body == nil {
		respond(w, 200, json.RawMessage(value))
		return
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", settingsKey, string(body)); err == nil {
		err = tx.Commit()
	}
	if err != nil {
		fail(w, 500, "阅读偏好保存失败")
		return
	}
	respond(w, 200, body)
}

func decodeSourceReadingPreferences(w http.ResponseWriter, r *http.Request) json.RawMessage {
	var state struct {
		Width    string          `json:"width"`
		Pinned   *bool           `json:"pinned"`
		Position json.RawMessage `json:"position,omitempty"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, sourceReadingPreferenceLimit))
	d.DisallowUnknownFields()
	err := d.Decode(&state)
	if err == nil {
		// Check for trailing JSON and enforce the byte limit even after the object.
		if err = d.Decode(new(json.RawMessage)); err == io.EOF {
			err = nil
		} else if err == nil {
			fail(w, 400, "无效的阅读偏好")
			return nil
		}
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		fail(w, 413, "阅读偏好内容过大")
		return nil
	}
	// Position is an opaque versioned anchor; the renderer validates its shape.
	if err != nil || (state.Width != "narrow" && state.Width != "standard" && state.Width != "wide") || state.Pinned == nil ||
		(len(state.Position) != 0 && state.Position[0] != '{' && string(state.Position) != "null") {
		fail(w, 400, "无效的阅读偏好")
		return nil
	}
	body, _ := json.Marshal(state)
	if len(body) > sourceReadingPreferenceLimit {
		fail(w, 413, "阅读偏好内容过大")
		return nil
	}
	return body
}

func validFontPreferences(v map[string]any) string {
	raw, exists := v["families"]
	if !exists {
		return ""
	}
	families, ok := raw.([]any)
	if !ok || len(families) > 10000 {
		return "字体列表格式无效"
	}
	for _, family := range families {
		name, ok := family.(string)
		if !ok || name == "" || len(name) > 256 {
			return "字体列表格式无效"
		}
	}
	return ""
}

// changeLabels renames (to != "") or removes a tag or folder on every document
// in a library, including the trash, in one transaction. Folders nest by "/",
// so subfolders follow; tags are flat.
// errInvalidTag is a rename that would produce an invalid tag on some document.
type errInvalidTag struct{ error }

// tagSuffix reports whether tag is name or nested under it, and the remainder.
func tagSuffix(tag, name string) (string, bool) {
	if strings.EqualFold(tag, name) {
		return "", true
	}
	if len(tag) > len(name) && tag[len(name)] == '/' && strings.EqualFold(tag[:len(name)], name) {
		return tag[len(name):], true
	}
	return "", false
}

func (s *Store) changeLabels(library, column, from, to string) (int, error) {
	nested := column == "folders"
	tx, err := s.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	rows, err := tx.Query("SELECT id,"+column+" FROM documents WHERE library=?", library)
	if err != nil {
		return 0, err
	}
	type change struct{ id, tags string }
	changes := []change{}
	for rows.Next() {
		var id, raw string
		var tags []string
		if err = rows.Scan(&id, &raw); err != nil || json.Unmarshal([]byte(raw), &tags) != nil {
			rows.Close()
			return 0, errors.New("标签数据损坏")
		}
		next, hit := []string{}, false
		for _, tag := range tags {
			if rest, ok := tagSuffix(tag, from); ok && (nested || rest == "") {
				hit = true
				if to == "" {
					continue
				}
				tag = to + rest
			}
			next = append(next, tag)
		}
		if !hit {
			continue
		}
		b, _ := json.Marshal(next)
		normalized, e := normalizeTags(b)
		if e != nil {
			rows.Close()
			return 0, errInvalidTag{e}
		}
		b, _ = json.Marshal(normalized)
		changes = append(changes, change{id, string(b)})
	}
	rows.Close()
	for _, c := range changes {
		if _, err = tx.Exec("UPDATE documents SET "+column+"=? WHERE id=?", c.tags, c.id); err != nil {
			return 0, err
		}
	}
	return len(changes), tx.Commit()
}

// changeLibraryLabels serves the tag and folder rename/remove endpoints.
func (s *Server) changeLibraryLabels(column string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { s.changeLibraryLabel(w, r, column) }
}

func (s *Server) changeLibraryLabel(w http.ResponseWriter, r *http.Request, column string) {
	library := r.PathValue("library")
	if !validLibrary(library) {
		fail(w, 404, "未知书库")
		return
	}
	var v struct {
		From string  `json:"from"`
		To   *string `json:"to"`
	}
	if !decode(w, r, &v) {
		return
	}
	from := strings.TrimSpace(v.From)
	to := ""
	if v.To != nil {
		b, _ := json.Marshal([]string{*v.To})
		names, err := normalizeTags(b)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		to = names[0]
	}
	if from == "" {
		fail(w, 400, "请指定名称")
		return
	}
	count, err := s.Store.changeLabels(library, column, from, to)
	var invalid errInvalidTag
	if errors.As(err, &invalid) {
		fail(w, 400, "改名后的名称须为 1–40 个字符（分类含上级分类）")
		return
	}
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	respond(w, 200, map[string]int{"changed": count})
}
