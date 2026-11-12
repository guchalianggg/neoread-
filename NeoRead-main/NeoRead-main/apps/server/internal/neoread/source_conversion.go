package neoread

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/xuri/excelize/v2"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	goldhtml "github.com/yuin/goldmark/renderer/html"
	nethtml "golang.org/x/net/html"
)

// These are reading-copy limits, not silent truncation thresholds. The source
// remains an immutable attachment; neither formulas nor macros are executed.
const (
	sourceResourceLimit = 32 << 20
	markdownSourceLimit = 8 << 20
	sourceMaxSheets     = 64
	sourceMaxRows       = 10000
	sourceMaxColumns    = 256
	sourceMaxCells      = 200000 // includes holes in each rendered rectangle, across sheets
)

type sourceConversionError struct{ code, message string }

func (e sourceConversionError) Error() string { return e.message }
func sourceError(code, message string) error  { return sourceConversionError{code, message} }
func auxiliarySource(kind string) bool {
	return kind == "md" || kind == "markdown" || kind == "xlsx" || kind == "xls" || kind == "doc" || kind == "docx"
}
func supportedImport(kind string) bool {
	return kind == "epub" || kind == "pdf" || auxiliarySource(kind)
}

type sourceChapter struct{ title, body string }
type sourceTOC struct{ title, href string }

// A context-aware reader is also used during archive validation and hashing, so
// cancellation never leaves a detached parsing goroutine or a partial import.
type sourceContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r sourceContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func convertSource(ctx context.Context, source, kind, title, identifier string, out io.Writer) (err error) {
	defer func() {
		if recover() != nil {
			if ctx.Err() != nil {
				err = ctx.Err()
			} else {
				err = sourceError("corrupt", "源文件损坏或使用了不支持的格式，无法生成阅读副本")
			}
		}
	}()
	if err = ctx.Err(); err != nil {
		return err
	}
	var chapters []sourceChapter
	var toc []sourceTOC
	switch kind {
	case "md", "markdown":
		chapters, toc, err = markdownChapters(ctx, source, title)
	case "xlsx":
		chapters, err = xlsxChapters(ctx, source)
	case "xls":
		chapters, err = xlsChapters(ctx, source)
	case "doc", "docx":
		chapters, toc, err = wordChapters(ctx, source, kind, title)
	default:
		return sourceError("format", "不支持此源文件格式")
	}
	if err != nil {
		return err
	}
	if len(toc) == 0 {
		for i, c := range chapters {
			toc = append(toc, sourceTOC{c.title, fmt.Sprintf("chapter-%d.xhtml", i+1)})
		}
	}
	return writeSourceEPUB(ctx, out, title, identifier, chapters, toc)
}

func markdownChapters(ctx context.Context, source, title string) ([]sourceChapter, []sourceTOC, error) {
	f, err := os.Open(source)
	if err != nil {
		return nil, nil, sourceError("read", "无法读取 Markdown 源文件")
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(sourceContextReader{ctx, f}, markdownSourceLimit+1))
	if err != nil {
		return nil, nil, err
	}
	if len(data) > markdownSourceLimit {
		return nil, nil, sourceError("limit", "Markdown 超过 8 MB 阅读转换上限")
	}
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	if !utf8.Valid(data) || bytes.IndexFunc(data, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) >= 0 || bytes.HasPrefix(data, []byte("%PDF-")) {
		return nil, nil, sourceError("format", "文件不是有效的 UTF-8 Markdown，请检查扩展名和文本编码")
	}
	var rendered bytes.Buffer
	md := goldmark.New(goldmark.WithExtensions(extension.GFM), goldmark.WithParserOptions(parser.WithAutoHeadingID()), goldmark.WithRendererOptions(goldhtml.WithXHTML()))
	// Goldmark's default deliberately omits raw HTML and dangerous link schemes.
	if err = md.Convert(data, &rendered); err != nil {
		return nil, nil, sourceError("corrupt", "Markdown 解析失败")
	}
	doc, err := nethtml.Parse(bytes.NewReader(rendered.Bytes()))
	if err != nil {
		return nil, nil, sourceError("corrupt", "Markdown 解析失败")
	}
	var toc []sourceTOC
	var text strings.Builder
	var walk func(*nethtml.Node)
	walk = func(n *nethtml.Node) {
		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			if c.Type == nethtml.ElementNode {
				if c.Data == "img" {
					// No network fetch, data URL, or path relative to the source directory.
					alt := "图片未嵌入"
					for _, a := range c.Attr {
						if a.Key == "alt" && a.Val != "" {
							alt += "：" + a.Val
						}
					}
					n.InsertBefore(&nethtml.Node{Type: nethtml.TextNode, Data: "[" + alt + "]"}, c)
					text.WriteString(alt)
					n.RemoveChild(c)
					c = next
					continue
				}
				if c.Data == "a" {
					attrs := c.Attr[:0]
					for _, a := range c.Attr {
						if a.Key == "href" {
							u, e := url.Parse(a.Val)
							if e != nil || !(u.Scheme == "http" || u.Scheme == "https" || u.Scheme == "mailto" || strings.HasPrefix(a.Val, "#")) {
								continue
							}
						}
						attrs = append(attrs, a)
					}
					c.Attr = attrs
				}
				if len(c.Data) == 2 && c.Data[0] == 'h' && c.Data[1] >= '1' && c.Data[1] <= '6' {
					var id string
					for _, a := range c.Attr {
						if a.Key == "id" {
							id = a.Val
						}
					}
					if id != "" {
						toc = append(toc, sourceTOC{sourceNodeText(c), "chapter-1.xhtml#" + url.PathEscape(id)})
					}
				}
			}
			if c.Type == nethtml.TextNode {
				text.WriteString(c.Data)
			}
			walk(c)
			c = next
		}
	}
	walk(doc)
	if strings.TrimSpace(text.String()) == "" {
		return nil, nil, sourceError("empty", "Markdown 没有可阅读的文本内容")
	}
	var body bytes.Buffer
	var findBody func(*nethtml.Node)
	findBody = func(n *nethtml.Node) {
		if n.Type == nethtml.ElementNode && n.Data == "body" {
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				writeXML(&body, c)
			}
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			findBody(c)
		}
	}
	findBody(doc)
	return []sourceChapter{{title, body.String()}}, toc, ctx.Err()
}
func sourceNodeText(n *nethtml.Node) string {
	var out strings.Builder
	var walk func(*nethtml.Node)
	walk = func(n *nethtml.Node) {
		if n.Type == nethtml.TextNode {
			out.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return out.String()
}

// Validate every ZIP member by actually reading it (including CRC), rather than
// trusting advertised sizes. Worksheet coordinates are checked before Excelize
// can allocate slices for an attacker-controlled sparse row or column.
func validateXLSX(ctx context.Context, source string) error {
	z, err := zip.OpenReader(source)
	if err != nil {
		return sourceError("format", "文件不是有效的 XLSX，可能已加密、损坏或扩展名不匹配")
	}
	defer z.Close()
	if len(z.File) > 10000 {
		return sourceError("limit", "Excel 压缩资源数量超过 10000 项")
	}
	var total int64
	seen := map[string]bool{}
	for _, entry := range z.File {
		if err = ctx.Err(); err != nil {
			return err
		}
		if _, err = safeResource(entry.Name); err != nil || seen[entry.Name] {
			return sourceError("format", "Excel 压缩包资源路径无效或重复")
		}
		seen[entry.Name] = true
		if entry.UncompressedSize64 > sourceResourceLimit {
			return sourceError("limit", "Excel 单个资源超过 32 MB 上限")
		}
		r, e := entry.Open()
		if e != nil {
			return sourceError("corrupt", "Excel 压缩资源无法读取")
		}
		data, e := io.ReadAll(io.LimitReader(sourceContextReader{ctx, r}, sourceResourceLimit+1))
		_ = r.Close()
		if e != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return sourceError("corrupt", "Excel 压缩资源损坏或校验失败")
		}
		total += int64(len(data))
		if len(data) > sourceResourceLimit || total > maxImportBytes {
			return sourceError("limit", "Excel 资源超过单项 32 MB 或总计 512 MB 上限")
		}
		// Relationships may place worksheets at nonstandard package paths.
		if strings.HasSuffix(strings.ToLower(entry.Name), ".xml") {
			if err = validateSheetXML(ctx, data); err != nil {
				return err
			}
		}
		if entry.Name == "[Content_Types].xml" && !bytes.Contains(data, []byte("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")) {
			return sourceError("format", "文件不是 XLSX 工作簿（不支持宏工作簿或扩展名伪装）")
		}
	}
	if !seen["[Content_Types].xml"] || !seen["xl/workbook.xml"] {
		return sourceError("format", "文件不是有效的 XLSX 工作簿")
	}
	return nil
}

func readXLSXSheets(ctx context.Context, source string) ([]sourceEditSheet, error) {
	if err := validateXLSX(ctx, source); err != nil {
		return nil, err
	}
	f, err := os.Open(source)
	if err != nil {
		return nil, sourceError("read", "无法读取 Excel 源文件")
	}
	defer f.Close()
	book, err := excelize.OpenReader(sourceContextReader{ctx, f}, excelize.Options{UnzipSizeLimit: maxImportBytes, UnzipXMLSizeLimit: sourceResourceLimit})
	if err != nil {
		return nil, sourceError("corrupt", "Excel 工作簿损坏、已加密或格式不受支持")
	}
	defer book.Close()
	names := book.GetSheetList()
	if len(names) == 0 {
		return nil, sourceError("empty", "Excel 没有工作表")
	}
	if len(names) > sourceMaxSheets {
		return nil, sourceError("limit", "Excel 工作表超过 64 个上限")
	}
	var sheets []sourceEditSheet
	budget := 0
	for _, name := range names {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		rows, e := book.Rows(name)
		if e != nil {
			return nil, sourceError("corrupt", "Excel 工作表无法读取，不支持以图表作为工作表")
		}
		var values [][]string
		maxCol := 0
		for rows.Next() {
			if ctx.Err() != nil {
				_ = rows.Close()
				return nil, ctx.Err()
			}
			cols, e := rows.Columns() // uses saved/display values, never CalcCellValue
			if e != nil {
				_ = rows.Close()
				return nil, sourceError("corrupt", "Excel 单元格读取失败")
			}
			if len(cols) > maxCol {
				maxCol = len(cols)
			}
			values = append(values, cols)
			if len(values) > sourceMaxRows || maxCol > sourceMaxColumns || len(values)*maxCol+budget > sourceMaxCells {
				_ = rows.Close()
				return nil, sourceTableLimit()
			}
		}
		rowErr, closeErr := rows.Error(), rows.Close()
		if rowErr != nil || closeErr != nil {
			return nil, sourceError("corrupt", "Excel 工作表读取未完成")
		}
		_, _, e = sourceTable(ctx, name, values, &budget)
		if e != nil {
			return nil, e
		}
		if values == nil {
			values = [][]string{}
		}
		for i := range values {
			if values[i] == nil {
				values[i] = []string{}
			}
		}
		sheets = append(sheets, sourceEditSheet{Name: name, Rows: values})
	}
	return sheets, nil
}
func xlsxChapters(ctx context.Context, source string) ([]sourceChapter, error) {
	sheets, err := readXLSXSheets(ctx, source)
	if err != nil {
		return nil, err
	}
	return sourceSheetChapters(ctx, sheets, false)
}
func sourceTableLimit() error {
	return sourceError("limit", "Excel 表格过大或过于稀疏：每表最多 10000 行、256 列，全部表格含空位最多 200000 个单元格；请拆分后导入")
}
func sourceTable(ctx context.Context, name string, rows [][]string, budget *int) (sourceChapter, bool, error) {
	maxCol := 0
	for _, row := range rows {
		if len(row) > maxCol {
			maxCol = len(row)
		}
	}
	if len(rows) > sourceMaxRows || maxCol > sourceMaxColumns || len(rows)*maxCol+*budget > sourceMaxCells {
		return sourceChapter{}, false, sourceTableLimit()
	}
	*budget += len(rows) * maxCol
	var body strings.Builder
	body.WriteString("<h1>" + html.EscapeString(name) + "</h1><table><tbody>")
	nonempty := false
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return sourceChapter{}, false, err
		}
		body.WriteString("<tr>")
		for col := 0; col < maxCol; col++ {
			value := ""
			if col < len(row) {
				value = row[col]
			}
			if strings.TrimSpace(value) != "" {
				nonempty = true
			}
			value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
			body.WriteString("<td>" + strings.ReplaceAll(html.EscapeString(value), "\n", "<br />") + "</td>")
			if body.Len() > sourceResourceLimit-4096 {
				return sourceChapter{}, false, sourceError("limit", "Excel 工作表的阅读副本超过单资源 32 MB 上限")
			}
		}
		body.WriteString("</tr>")
	}
	body.WriteString("</tbody></table>")
	if !nonempty {
		body.WriteString("<p>空工作表</p>")
	}
	return sourceChapter{name, body.String()}, nonempty, nil
}

const sourceEPUBStyle = `body{font-family:sans-serif;line-height:1.6}table{border-collapse:collapse;max-width:100%;overflow-wrap:anywhere}td,th{border:1px solid #888;padding:.35em;vertical-align:top;white-space:pre-wrap}pre{white-space:pre-wrap}code{overflow-wrap:anywhere}`

func writeSourceEPUB(ctx context.Context, out io.Writer, title, identifier string, chapters []sourceChapter, toc []sourceTOC) error {
	z := zip.NewWriter(out)
	var total int
	add := func(name, data string, method uint16) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		total += len(data)
		if len(data) > sourceResourceLimit || total > maxImportBytes {
			return sourceError("limit", "阅读副本超过单资源 32 MB 或总计 512 MB 上限")
		}
		// Zero timestamp and stable order make identical conversions byte-for-byte deterministic.
		w, err := z.CreateHeader(&zip.FileHeader{Name: name, Method: method})
		if err != nil {
			return err
		}
		_, err = io.WriteString(w, data)
		return err
	}
	x := html.EscapeString
	if err := add("mimetype", "application/epub+zip", zip.Store); err != nil {
		return err
	}
	if err := add("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`, zip.Deflate); err != nil {
		return err
	}
	var manifest, spine, nav strings.Builder
	manifest.WriteString(`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>`)
	for i, c := range chapters {
		id := strconv.Itoa(i + 1)
		href := "chapter-" + id + ".xhtml"
		manifest.WriteString(`<item id="c` + id + `" href="` + href + `" media-type="application/xhtml+xml"/>`)
		spine.WriteString(`<itemref idref="c` + id + `"/>`)
		content := `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" lang="zh"><head><title>` + x(c.title) + `</title><link rel="stylesheet" href="style.css"/></head><body>` + c.body + `</body></html>`
		if err := add("EPUB/"+href, content, zip.Deflate); err != nil {
			return err
		}
	}
	for _, entry := range toc {
		nav.WriteString(`<li><a href="` + x(entry.href) + `">` + x(entry.title) + `</a></li>`)
	}
	opf := `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:sha256:` + x(identifier) + `</dc:identifier><dc:title>` + x(title) + `</dc:title><dc:language>zh</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata><manifest>` + manifest.String() + `</manifest><spine>` + spine.String() + `</spine></package>`
	for _, entry := range []struct{ name, data string }{{"EPUB/package.opf", opf}, {"EPUB/style.css", sourceEPUBStyle}, {"EPUB/nav.xhtml", `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>` + nav.String() + `</ol></nav></body></html>`}} {
		if err := add(entry.name, entry.data, zip.Deflate); err != nil {
			return err
		}
	}
	if err := z.Close(); err != nil {
		return err
	}
	return ctx.Err()
}

// Conversion errors have stable, content-free diagnostic reason codes.
func sourceReason(err error) string {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return "cancelled"
	}
	var e sourceConversionError
	if errors.As(err, &e) {
		return e.code
	}
	return "write"
}
