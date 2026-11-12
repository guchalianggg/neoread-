// Package venues 将文献来源名称规范化为中国计算机学会推荐目录（第七版）的标准
// 写法「简称 (全称)」，例如 "International Conference on Machine Learning" 与
// "ICML" 都规范化为 "ICML (International Conference on Machine Learning)"。
//
// 匹配分三层，依次尝试：
//  1. 简称精确匹配（目录内简称唯一时；tcc/sec/cc 等 9 个歧义简称不参与）；
//  2. 全称精确匹配（忽略大小写、标点与空白差异）；
//  3. 全称词窗匹配：允许 "Proceedings of the 31st ACM …" 这类前导词和
//     "Volume 2"、"Long Papers" 这类尾缀词，其余内容必须与全称完全一致。
//     词窗限制避免了 "Asia-Pacific Conference on Machine Learning"、
//     "International Conference on Machine Learning and Applications" 被
//     误归为 ICML 的假阳性。
//
// 未命中时原样返回，绝不猜测。
package venues

import (
	_ "embed"
	"encoding/json"
	"strings"
)

//go:embed ccf7.json
var catalogJSON []byte

type catalogEntry struct {
	Kind      string `json:"kind"`
	Tier      string `json:"tier"`
	Area      string `json:"area"`
	Abbr      string `json:"abbr"`
	Full      string `json:"full"`
	Publisher string `json:"publisher"`
	Seq       int    `json:"seq"`
}

var (
	abbrExact   = map[string]string{} // 唯一简称（规范化键） -> 标准写法
	fullExact   = map[string]string{} // 全称（规范化键） -> 标准写法
	fullPhrases []phrase              // 全称词序列（≥4 词）用于词窗匹配
)

type phrase struct {
	tokens    []string
	canonical string
}

// allowedHead 是全称之前允许出现的前导词（论文出处字符串的通用外壳）。
// advances 对应 NeurIPS 论文的常见卷名 "Advances in Neural Information
// Processing Systems"。
var allowedHead = newSet("proceedings", "in", "of", "the", "a", "an", "acm", "ieee",
	"usenix", "springer", "elsevier", "wiley", "association", "for", "computing",
	"machinery", "annual", "joint", "advances")

// allowedTail 是全称之后允许出现的尾缀词（卷号、篇幅等）。
var allowedTail = newSet("volume", "vol", "part", "parts", "pages", "proceedings",
	"paper", "papers", "long", "short", "main", "track", "tracks",
	"i", "ii", "iii", "iv", "v", "vi", "vii")

func init() {
	var doc struct {
		Entries []catalogEntry `json:"entries"`
	}
	if err := json.Unmarshal(catalogJSON, &doc); err != nil {
		panic("venues: 无法解析内置 CCF 目录: " + err.Error())
	}
	fullSeen := map[string]string{} // 简称规范化键 -> 标记，用于放弃歧义简称
	for _, e := range doc.Entries {
		if e.Full == "" {
			continue
		}
		canonical := e.Full
		if e.Abbr != "" {
			canonical = e.Abbr + " (" + e.Full + ")"
		}
		fullKey := key(e.Full)
		if _, dup := fullExact[fullKey]; !dup {
			fullExact[fullKey] = canonical
		}
		if tokens := strings.Fields(fullKey); len(tokens) >= 4 {
			fullPhrases = append(fullPhrases, phrase{tokens: tokens, canonical: canonical})
		}
		if e.Abbr != "" {
			abbrKey := key(e.Abbr)
			if prev, dup := abbrExact[abbrKey]; dup && prev != canonical {
				delete(abbrExact, abbrKey) // 同简称对应多个不同全称：放弃简称匹配
				fullSeen[abbrKey] = "\x00ambiguous"
				continue
			}
			if fullSeen[abbrKey] == "\x00ambiguous" {
				continue
			}
			fullSeen[abbrKey] = abbrKey
			abbrExact[abbrKey] = canonical
		}
	}
	// NeurIPS 论文集的卷名与会议全称是两个不同的字符串，目录之外补充别名：
	// "Advances in Neural Information Processing Systems"（及旧称 NIPS）。
	if v, ok := fullExact[key("Conference on Neural Information Processing Systems")]; ok {
		if _, taken := abbrExact[key("NIPS")]; !taken {
			abbrExact[key("NIPS")] = v
		}
		for _, alias := range []string{
			"Advances in Neural Information Processing Systems",
			"Neural Information Processing Systems",
		} {
			fullPhrases = append(fullPhrases, phrase{tokens: strings.Fields(key(alias)), canonical: v})
		}
	}
	// 最长全称优先：更具体的名字先参与词窗匹配。
	for i := 1; i < len(fullPhrases); i++ {
		for j := i; j > 0 && len(fullPhrases[j-1].tokens) < len(fullPhrases[j].tokens); j-- {
			fullPhrases[j-1], fullPhrases[j] = fullPhrases[j], fullPhrases[j-1]
		}
	}
}

func newSet(words ...string) map[string]bool {
	s := make(map[string]bool, len(words))
	for _, w := range words {
		s[w] = true
	}
	return s
}

// key 把名称折叠成小写、以空格分隔的字母数字词序列，忽略所有标点。
func key(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else {
			b.WriteByte(' ')
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

func isOrdinal(token string) bool {
	if len(token) < 3 {
		return false
	}
	switch token[len(token)-2:] {
	case "st", "nd", "rd", "th":
		digits := token[:len(token)-2]
		if digits == "" {
			return false
		}
		for _, r := range digits {
			if r < '0' || r > '9' {
				return false
			}
		}
		return true
	}
	return false
}

func isTailToken(token string) bool {
	if allowedTail[token] {
		return true
	}
	for _, r := range token {
		if r < '0' || r > '9' {
			return false
		}
	}
	return len(token) > 0
}

// windowMatch 报告 tokens 是否恰由「允许的前导词 + phrase + 允许的尾缀词」构成。
func windowMatch(tokens, phraseTokens []string) bool {
	n, m := len(tokens), len(phraseTokens)
	for start := 0; start+m <= n; start++ {
		end := start + m
		match := true
		for i := 0; i < m; i++ {
			if tokens[start+i] != phraseTokens[i] {
				match = false
				break
			}
		}
		if !match {
			continue
		}
		headOK := true
		for i := 0; i < start; i++ {
			t := tokens[i]
			if !allowedHead[t] && !isOrdinal(t) {
				headOK = false
				break
			}
		}
		tailOK := true
		for i := end; i < n; i++ {
			if !isTailToken(tokens[i]) {
				tailOK = false
				break
			}
		}
		if headOK && tailOK {
			return true
		}
	}
	return false
}

// arXivVariants 是预印本平台的常见写法，统一为 arXiv (preprint)。
var arXivVariants = newSet("arxiv", "arxiv org", "arxiv preprint", "arxiv e print",
	"arxiv e prints", "arxiv cornell university", "cornell university arxiv",
	"arxiv cs", "arxiv mathematical sciences")

// Normalize 返回 venue 的标准写法；无法识别时原样返回（仅去除首尾空白）。
func Normalize(venue string) string {
	venue = strings.TrimSpace(venue)
	if venue == "" {
		return ""
	}
	k := key(venue)
	if k == "" {
		return venue
	}
	if arXivVariants[k] {
		return "arXiv (preprint)"
	}
	if v, ok := abbrExact[k]; ok {
		return v
	}
	if v, ok := fullExact[k]; ok {
		return v
	}
	if tokens := strings.Fields(k); len(tokens) >= 4 {
		for _, p := range fullPhrases {
			if len(p.tokens) > len(tokens) {
				continue
			}
			if windowMatch(tokens, p.tokens) {
				return p.canonical
			}
		}
	}
	return venue
}
