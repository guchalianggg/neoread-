package neoread

import (
	"strings"
	"testing"
)

func TestPaperAttachmentCountUsesOwnershipIndexAfterUpgrade(t *testing.T) {
	root := t.TempDir()
	store, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.DB.Exec(`INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,percentage) VALUES('paper','pdf','Paper','',10,'t','t',0.5);
 INSERT INTO paper_attachments(id,document_id,kind,title,url,created_at) VALUES('link','paper','link','Supplement','https://example.org/supplement','t');
 DROP INDEX IF EXISTS paper_attachment_owner;`)
	if err != nil {
		store.DB.Close()
		t.Fatal(err)
	}
	if err := store.DB.Close(); err != nil {
		t.Fatal(err)
	}
	upgraded, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.DB.Close()
	d, err := upgraded.Document("paper")
	if err != nil || d.AttachmentCount != 1 || d.Percentage != 0.5 {
		t.Fatalf("upgrade changed data: %+v %v", d, err)
	}
	rows, err := upgraded.DB.Query(`EXPLAIN QUERY PLAN SELECT id,(SELECT count(*) FROM paper_attachments a WHERE a.document_id=documents.id) FROM documents`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	indexed := false
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		t.Log(detail)
		if strings.Contains(detail, "SEARCH a ") && strings.Contains(detail, "document_id=?") {
			indexed = true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !indexed {
		t.Fatal("attachment count still scans all attachments for each paper")
	}
}
