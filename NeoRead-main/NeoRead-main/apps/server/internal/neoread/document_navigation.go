package neoread

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"
)

type navigationEdit struct {
	Deleted   *bool           `json:"deleted,omitempty"`
	Label     *string         `json:"label,omitempty"`
	Kind      string          `json:"kind,omitempty"`
	ParentID  json.RawMessage `json:"parentId,omitempty"`
	Collapsed *bool           `json:"collapsed,omitempty"`
}
type documentNavigation struct {
	Revision int                       `json:"revision"`
	Entries  map[string]navigationEdit `json:"entries"`
}

func (s *Server) documentNavigation(w http.ResponseWriter, r *http.Request) {
	if _, err := s.Store.Document(r.PathValue("id")); err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	result := documentNavigation{Entries: map[string]navigationEdit{}}
	var body string
	err := s.Store.DB.QueryRow("SELECT revision,body FROM document_navigation WHERE document_id=?", r.PathValue("id")).Scan(&result.Revision, &body)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		fail(w, 500, "无法读取目录设置")
		return
	}
	if err == nil && json.Unmarshal([]byte(body), &result.Entries) != nil {
		fail(w, 500, "目录设置损坏")
		return
	}
	respond(w, 200, result)
}
func validNavigation(n documentNavigation) bool {
	if n.Revision < 0 || len(n.Entries) > 10000 || n.Entries == nil {
		return false
	}
	parents := map[string]string{}
	for id, e := range n.Entries {
		if id == "" || len(id) > 256 || id == "__proto__" || id == "constructor" || id == "prototype" {
			return false
		}
		if e.Kind != "" && e.Kind != "heading" && e.Kind != "bookmark" {
			return false
		}
		if e.Label != nil && (strings.TrimSpace(*e.Label) == "" || utf8.RuneCountInString(*e.Label) > 500) {
			return false
		}
		if len(e.ParentID) > 0 && string(e.ParentID) != "null" {
			var parent string
			if json.Unmarshal(e.ParentID, &parent) != nil || parent == "" || len(parent) > 256 || parent == id {
				return false
			}
			parents[id] = parent
		}
	}
	for id := range parents {
		seen := map[string]bool{}
		for current := id; current != ""; current = parents[current] {
			if len(seen) > 64 || seen[current] {
				return false
			}
			seen[current] = true
		}
	}
	return true
}
func (s *Server) saveDocumentNavigation(w http.ResponseWriter, r *http.Request) {
	var n documentNavigation
	if !decode(w, r, &n) {
		return
	}
	if !validNavigation(n) {
		fail(w, 400, "目录设置无效")
		return
	}
	if _, err := s.Store.Document(r.PathValue("id")); err != nil {
		fail(w, 404, "文档不存在")
		return
	}
	body, err := json.Marshal(n.Entries)
	if err != nil {
		fail(w, 400, "目录设置无效")
		return
	}
	var result sql.Result
	if n.Revision == 0 {
		result, err = s.Store.DB.Exec("INSERT INTO document_navigation(document_id,revision,body) VALUES(?,1,?) ON CONFLICT(document_id) DO NOTHING", r.PathValue("id"), string(body))
	} else {
		result, err = s.Store.DB.Exec("UPDATE document_navigation SET revision=revision+1,body=? WHERE document_id=? AND revision=?", string(body), r.PathValue("id"), n.Revision)
	}
	if err != nil {
		fail(w, 500, "目录保存失败")
		return
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		fail(w, 409, "目录已在另一窗口修改，请重新加载后再试")
		return
	}
	n.Revision++
	respond(w, 200, n)
}
