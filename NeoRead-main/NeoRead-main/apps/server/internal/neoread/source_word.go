package neoread

import (
	"archive/zip"
	"bytes"
	"context"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"encoding/xml"
	nethtml "golang.org/x/net/html"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/richardlehane/mscfb"
)

//go:embed source_word.ps1
var sourceWordScript []byte

// Validate the complete archive (actual inflated bytes and CRCs) before pandoc.
// Only non-macro DOCX packages are accepted, not ZIPs renamed as Word documents.
func validateDOCX(ctx context.Context, path string) error {
	z, err := zip.OpenReader(path)
	if err != nil {
		return sourceError("format", "文件不是有效的 DOCX，可能已加密、损坏或扩展名不匹配")
	}
	defer z.Close()
	if len(z.File) > 10000 {
		return sourceError("limit", "Word 压缩资源超过 10000 项上限")
	}
	seen, total, document, types := map[string]bool{}, 0, false, false
	for _, f := range z.File {
		name, e := safeResource(f.Name)
		if e != nil || name != strings.TrimSuffix(f.Name, "/") || seen[name] {
			return sourceError("format", "Word 资源路径无效或重复")
		}
		seen[name] = true
		if f.UncompressedSize64 > sourceResourceLimit {
			return sourceError("limit", "Word 单个资源超过 32 MiB 上限")
		}
		r, e := f.Open()
		if e != nil {
			return sourceError("corrupt", "Word 压缩资源损坏")
		}
		data, e := io.ReadAll(io.LimitReader(sourceContextReader{ctx, r}, sourceResourceLimit+1))
		_ = r.Close()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if e != nil {
			return sourceError("corrupt", "Word 压缩资源损坏或校验失败")
		}
		total += len(data)
		if len(data) > sourceResourceLimit || total > 64<<20 {
			return sourceError("limit", "Word 解压资源超过单项 32 MiB 或总计 64 MiB 上限")
		}
		if strings.HasSuffix(strings.ToLower(name), "vbaproject.bin") {
			return sourceError("format", "不支持含宏的 Word 工作副本，请另存为无宏 DOCX")
		}
		if name == "[Content_Types].xml" {
			types = bytes.Contains(data, []byte("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")) && !bytes.Contains(bytes.ToLower(data), []byte("macroenabled"))
		}
		if name == "word/document.xml" {
			d := xml.NewDecoder(sourceContextReader{ctx, bytes.NewReader(data)})
			depth, root := 0, false
			for {
				token, e := d.Token()
				if e == io.EOF {
					break
				}
				if e != nil {
					return sourceError("corrupt", "Word 正文 XML 损坏")
				}
				switch t := token.(type) {
				case xml.StartElement:
					if depth == 0 {
						if root || t.Name.Local != "document" || t.Name.Space != "http://schemas.openxmlformats.org/wordprocessingml/2006/main" {
							return sourceError("format", "Word 正文格式无效")
						}
						root = true
					}
					depth++
				case xml.EndElement:
					depth--
				}
			}
			document = root && depth == 0
		}
	}
	if !document || !types || !seen["_rels/.rels"] {
		return sourceError("format", "文件缺少有效 DOCX 文档结构")
	}
	return ctx.Err()
}

func validateDOC(ctx context.Context, path string) (err error) {
	defer func() {
		if recover() != nil {
			if ctx.Err() != nil {
				err = ctx.Err()
			} else {
				err = sourceError("corrupt", "DOC 复合文档损坏")
			}
		}
	}()
	data, err := readSourceBounded(ctx, path, sourceResourceLimit)
	if err != nil {
		return err
	}
	if len(data) < 512 || !bytes.Equal(data[:8], []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}) {
		return sourceError("format", "文件不是有效的二进制 DOC，不能将文本改名导入")
	}
	shift := binary.LittleEndian.Uint16(data[30:32])
	if shift != 9 && shift != 12 {
		return sourceError("corrupt", "DOC 扇区大小无效")
	}
	for _, off := range []int{40, 44, 64, 72} {
		if binary.LittleEndian.Uint32(data[off:off+4]) > uint32(len(data)>>shift) {
			return sourceError("corrupt", "DOC 扇区数量超出边界")
		}
	}
	container, err := mscfb.New(&sourceXLSReader{ctx, bytes.NewReader(data), maxImportBytes})
	if err != nil {
		return sourceError("corrupt", "DOC 复合文档损坏或已加密")
	}
	if len(container.File) > 10000 {
		return sourceError("limit", "DOC 资源数量超过上限")
	}
	var fib []byte
	table := false
	for _, f := range container.File {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if f.Size < 0 || f.Size > sourceResourceLimit {
			return sourceError("limit", "DOC 资源尺寸超过上限")
		}
		if f.Name == "EncryptedPackage" || f.Name == "EncryptionInfo" {
			return sourceError("encrypted", "不支持加密的 Word，请先解密后导入")
		}
		if f.Name == "0Table" || f.Name == "1Table" {
			table = true
		}
		if f.Name == "WordDocument" {
			if fib != nil {
				return sourceError("corrupt", "DOC 正文流重复")
			}
			fib = make([]byte, 32)
			if _, e := io.ReadFull(sourceContextReader{ctx, f}, fib); e != nil {
				return sourceError("corrupt", "DOC 正文流损坏")
			}
		}
	}
	if len(fib) < 32 || binary.LittleEndian.Uint16(fib[:2]) != 0xa5ec || !table {
		return sourceError("format", "DOC 缺少 Word 正文或表格流，不能以其他格式改名导入")
	}
	if binary.LittleEndian.Uint16(fib[10:12])&0x8100 != 0 {
		return sourceError("encrypted", "不支持加密的 Word，请先解密后导入")
	}
	return ctx.Err()
}

// No shell expressions contain paths. The embedded script and every parameter
// are separate argv entries; work is never run from the original's directory.
func convertLegacyDOC(ctx context.Context, source, out, work string) (resultErr error) {
	finish := sourceConversionStage(ctx, "word_com", "doc_to_docx")
	defer func() { finish(resultErr) }()
	if err := validateDOC(ctx, source); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		return sourceError("dependency", "DOC 转换需要 Windows Microsoft Word，请另存为 DOCX 后导入")
	}
	powershell, err := exec.LookPath("powershell.exe")
	if err != nil {
		return sourceError("dependency", "未找到受控 Word 转换环境，请另存为 DOCX 后导入")
	}
	script := filepath.Join(work, "convert.ps1")
	// Windows PowerShell 5 interprets UTF-8 correctly only with a BOM.
	if err = os.WriteFile(script, append([]byte{0xef, 0xbb, 0xbf}, sourceWordScript...), 0600); err != nil {
		return err
	}
	pidFile := filepath.Join(work, "word-process.json")
	// Always verify and reap only the newly created private Word process, even
	// when CommandContext killed PowerShell before its finally block could run.
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(cleanupCtx, powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", "cleanup", "-PidFile", pidFile)
		cmd.Dir = work
		cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
		_ = cmd.Run()
	}()
	runCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(runCtx, powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", "convert", "-Source", source, "-Destination", out, "-PidFile", pidFile)
	cmd.Dir = work
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if err = cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if runCtx.Err() != nil {
			return sourceError("timeout", "Word 转换超时，原件和上一版本已保留")
		}
		return sourceError("corrupt", "Word 转换失败：文件可能损坏、加密，或 Microsoft Word 不可用")
	}
	return validateDOCX(ctx, out)
}

// The DOCX reader never receives an external relationship, macro or embedded
// object. Internal media can be parsed but is removed from the AST, never fetched.
func safeWordPackage(ctx context.Context, source, target string) error {
	if err := validateDOCX(ctx, source); err != nil {
		return err
	}
	z, err := zip.OpenReader(source)
	if err != nil {
		return err
	}
	defer z.Close()
	f, err := os.Create(target)
	if err != nil {
		return err
	}
	defer f.Close()
	out := zip.NewWriter(f)
	for _, entry := range z.File {
		if err = ctx.Err(); err != nil {
			return err
		}
		if entry.FileInfo().IsDir() || strings.HasPrefix(entry.Name, "word/embeddings/") || strings.HasPrefix(entry.Name, "customXml/") {
			continue
		}
		r, e := entry.Open()
		if e != nil {
			return sourceError("corrupt", "Word 资源无法读取")
		}
		data, e := io.ReadAll(io.LimitReader(sourceContextReader{ctx, r}, sourceResourceLimit+1))
		_ = r.Close()
		if e != nil {
			return e
		}
		if strings.HasSuffix(entry.Name, ".rels") {
			var rels struct {
				XMLName xml.Name `xml:"http://schemas.openxmlformats.org/package/2006/relationships Relationships"`
				Items   []struct {
					ID     string `xml:"Id,attr"`
					Type   string `xml:"Type,attr"`
					Target string `xml:"Target,attr"`
					Mode   string `xml:"TargetMode,attr,omitempty"`
				} `xml:"Relationship"`
			}
			if e = xml.Unmarshal(data, &rels); e != nil {
				return sourceError("corrupt", "Word 关系资源损坏")
			}
			kept := rels.Items[:0]
			for _, rel := range rels.Items {
				if strings.EqualFold(rel.Mode, "External") || strings.HasSuffix(rel.Type, "/oleObject") || strings.HasSuffix(rel.Type, "/aFChunk") {
					continue
				}
				if _, e := safeResource(rel.Target); e != nil {
					continue
				}
				kept = append(kept, rel)
			}
			rels.Items = kept
			data, e = xml.Marshal(rels)
			if e != nil {
				return e
			}
		}
		w, e := out.Create(entry.Name)
		if e != nil {
			return e
		}
		if _, e = w.Write(data); e != nil {
			return e
		}
	}
	return out.Close()
}

type sourcePandocOutput struct {
	buffer   bytes.Buffer
	limit    int
	overflow bool
}

func (w *sourcePandocOutput) Len() int      { return w.buffer.Len() }
func (w *sourcePandocOutput) Bytes() []byte { return w.buffer.Bytes() }

func (w *sourcePandocOutput) Write(p []byte) (int, error) {
	if len(p) > w.limit-w.Len() {
		w.overflow = true
		return 0, sourceError("limit", "Word 转换输出超过尺寸上限")
	}
	return w.buffer.Write(p)
}
func runSourcePandoc(ctx context.Context, work, from, to string, input []byte, filename string) (output []byte, resultErr error) {
	finish := sourceConversionStage(ctx, "pandoc", from+"_to_"+to)
	defer func() { finish(resultErr) }()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path, err := exec.LookPath("pandoc")
	if err != nil {
		return nil, sourceError("dependency", "未找到 pandoc，暂时无法转换 Word 文档")
	}
	runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	args := []string{"--sandbox", "--from=" + from, "--to=" + to, "--wrap=none", "--output=-"}
	if filename != "" {
		args = append(args, "--", filename)
	}
	cmd := exec.CommandContext(runCtx, path, args...)
	cmd.Dir = work
	cmd.Stdin = bytes.NewReader(input)
	cmd.Stderr = io.Discard
	out := &sourcePandocOutput{limit: sourceResourceLimit}
	cmd.Stdout = out
	if err = cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if runCtx.Err() != nil {
			return nil, sourceError("timeout", "Word 转换超时，原件和上一版本已保留")
		}
		if out.overflow {
			return nil, sourceError("limit", "Word 转换输出超过 32 MiB 上限")
		}
		return nil, sourceError("corrupt", "Word 正文转换失败，文件可能损坏或格式不受支持")
	}
	return out.Bytes(), nil
}

// Strip all links/images/raw HTML before any writer runs. Unlike regex-based
// Markdown filtering this handles references, nested syntax and DOCX hyperlinks.
func sanitizeWordAST(raw []byte) ([]byte, error) {
	var ast any
	if err := json.Unmarshal(raw, &ast); err != nil {
		return nil, sourceError("corrupt", "Word 中间格式无效")
	}
	var walk func(any) any
	walk = func(v any) any {
		switch x := v.(type) {
		case []any:
			filtered := make([]any, 0, len(x))
			blocked := 0
			for _, child := range x {
				if node, ok := child.(map[string]any); ok && node["t"] == "RawInline" {
					if c, ok := node["c"].([]any); ok && len(c) == 2 {
						if raw, ok := c[1].(string); ok {
							z := nethtml.NewTokenizer(strings.NewReader(raw))
							token := z.Next()
							name, _ := z.TagName()
							switch string(name) {
							case "script", "style", "iframe", "object", "svg", "math":
								if token == nethtml.StartTagToken {
									blocked++
								}
								if token == nethtml.EndTagToken && blocked > 0 {
									blocked--
								}
							}
						}
						continue
					}
				}
				if blocked == 0 {
					filtered = append(filtered, walk(child))
				}
			}
			return filtered
		case map[string]any:
			t, _ := x["t"].(string)
			switch t {
			case "RawInline":
				return map[string]any{"t": "Str", "c": ""}
			case "RawBlock":
				return map[string]any{"t": "Para", "c": []any{}}
			case "Link", "Image":
				c, ok := x["c"].([]any)
				if !ok || len(c) < 2 {
					return map[string]any{"t": "Str", "c": ""}
				}
				inlines := c[1]
				if t == "Image" {
					inlines = []any{map[string]any{"t": "Str", "c": "[图片未嵌入]"}}
				}
				return map[string]any{"t": "Span", "c": []any{[]any{"", []any{}, []any{}}, walk(inlines)}}
			}
			for k, child := range x {
				x[k] = walk(child)
			}
			return x
		}
		return v
	}
	return json.Marshal(walk(ast))
}
func normalizeWordMarkdown(ctx context.Context, work, text string) (string, []byte, error) {
	ast, err := runSourcePandoc(ctx, work, "gfm", "json", []byte(text), "")
	if err != nil {
		return "", nil, err
	}
	ast, err = sanitizeWordAST(ast)
	if err != nil {
		return "", nil, err
	}
	md, err := runSourcePandoc(ctx, work, "json", "gfm-raw_html", ast, "")
	if err != nil {
		return "", nil, err
	}
	if len(md) > sourceEditTextLimit {
		return "", nil, sourceError("limit", "Word 正文超过 8 MiB 编辑上限")
	}
	return string(md), ast, nil
}
func writeWordFile(ctx context.Context, text, path string) (string, error) {
	work, err := os.MkdirTemp("", "neoread-word-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	canonical, ast, err := normalizeWordMarkdown(ctx, work, text)
	if err != nil {
		return "", err
	}
	data, err := runSourcePandoc(ctx, work, "json", "docx", ast, "")
	if err != nil {
		return "", err
	}
	if err = os.WriteFile(path, data, 0600); err != nil {
		return "", err
	}
	if text == "" {
		canonical = ""
	}
	return canonical, validateDOCX(ctx, path)
}
func markdownToDOCX(ctx context.Context, text, path string) error {
	_, err := writeWordFile(ctx, text, path)
	return err
}
func wordMarkdown(ctx context.Context, source, kind string) (string, error) {
	work, err := os.MkdirTemp("", "neoread-word-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	if kind == "doc" {
		converted := filepath.Join(work, "converted.docx")
		// Word receives a private copy, not the attachment itself.
		data, e := readSourceBounded(ctx, source, sourceResourceLimit)
		if e != nil {
			return "", e
		}
		copyPath := filepath.Join(work, "input.doc")
		if e = os.WriteFile(copyPath, data, 0600); e != nil {
			return "", e
		}
		if err = convertLegacyDOC(ctx, copyPath, converted, work); err != nil {
			return "", err
		}
		source = converted
	}
	input := filepath.Join(work, "safe.docx")
	if err = safeWordPackage(ctx, source, input); err != nil {
		return "", err
	}
	ast, err := runSourcePandoc(ctx, work, "docx", "json", nil, input)
	if err != nil {
		return "", err
	}
	ast, err = sanitizeWordAST(ast)
	if err != nil {
		return "", err
	}
	data, err := runSourcePandoc(ctx, work, "json", "gfm-raw_html", ast, "")
	if err != nil {
		return "", err
	}
	if len(data) > sourceEditTextLimit {
		return "", sourceError("limit", "Word 正文超过 8 MiB 编辑上限")
	}
	return string(data), nil
}
func wordChapters(ctx context.Context, source, kind, title string) ([]sourceChapter, []sourceTOC, error) {
	text, err := wordMarkdown(ctx, source, kind)
	if err != nil {
		return nil, nil, err
	}
	work, err := os.MkdirTemp("", "neoread-word-reading-*")
	if err != nil {
		return nil, nil, err
	}
	defer os.RemoveAll(work)
	path := filepath.Join(work, "body.md")
	if err = os.WriteFile(path, []byte(text), 0600); err != nil {
		return nil, nil, err
	}
	chapters, toc, err := markdownChapters(ctx, path, title)
	if sourceReason(err) == "empty" {
		return []sourceChapter{{title, "<p>空文档</p>"}}, nil, nil
	}
	return chapters, toc, err
}
