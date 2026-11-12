package neoread

import (
	"strings"
	"testing"
)

func TestPredominantlyChinese(t *testing.T) {
	body := func(text string) layoutManifest {
		block := PDFBlock{ID: "p1-b1", Page: 1, Label: "text", Text: text}
		return layoutManifest{Pages: 1, Blocks: []PDFBlock{block}}
	}
	for _, tc := range []struct {
		name string
		text string
		want bool
	}{
		{"中文正文", strings.Repeat("中文正文段落测试内容", 30), true},
		{"英文正文", strings.Repeat("Original English body text. ", 30), false},
		{"中文正文夹英文引用", strings.Repeat("中文正文段落测试内容", 30) + strings.Repeat("A reference title. ", 12), true},
		{"样本过短", "中文正文", false},
		{"混合但英文为主", strings.Repeat("Original English body text. ", 30) + strings.Repeat("中文", 5), false},
		{"无文字", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := predominantlyChinese(body(tc.text)); got != tc.want {
				t.Fatalf("predominantlyChinese(%q) = %t, want %t", tc.text, got, tc.want)
			}
		})
	}
}
