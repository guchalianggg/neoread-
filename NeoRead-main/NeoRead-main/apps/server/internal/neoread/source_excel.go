package neoread

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/xml"
	"io"
	"math"
	"os"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/richardlehane/mscfb"
	"github.com/shakinm/xlsReader/xls"
	"github.com/xuri/excelize/v2"
)

func validateSheetXML(ctx context.Context, data []byte) error {
	d := xml.NewDecoder(sourceContextReader{ctx, bytes.NewReader(data)})
	rootSeen := false
	row, col, maxRow, maxCol := 0, 0, 0, 0
	inCell, formula, hasValue := false, false, false
	for {
		token, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return sourceError("corrupt", "Excel 工作表 XML 损坏")
		}
		switch t := token.(type) {
		case xml.StartElement:
			if !rootSeen {
				rootSeen = true
				if t.Name.Local != "worksheet" {
					return nil
				}
			}
			switch t.Name.Local {
			case "row":
				row++
				col = 0
				for _, a := range t.Attr {
					if a.Name.Local == "r" {
						n, e := strconv.Atoi(a.Value)
						if e != nil || n < row {
							return sourceError("corrupt", "Excel 行号无效或重复")
						}
						row = n
					}
				}
				if row > maxRow {
					maxRow = row
				}
			case "c":
				inCell, formula, hasValue = true, false, false
				col++
				for _, a := range t.Attr {
					if a.Name.Local == "r" {
						c, r, e := excelize.CellNameToCoordinates(a.Value)
						if e != nil || r != row || c < col {
							return sourceError("corrupt", "Excel 单元格坐标无效或重复")
						}
						col = c
					}
				}
				if col > maxCol {
					maxCol = col
				}
			case "f":
				if inCell {
					formula = true
				}
			case "v":
				if inCell {
					var v string
					if e := d.DecodeElement(&v, &t); e != nil {
						return sourceError("corrupt", "Excel 单元格值损坏")
					}
					hasValue = strings.TrimSpace(v) != ""
				}
			}
		case xml.EndElement:
			if t.Name.Local == "c" {
				if formula && !hasValue {
					return sourceError("formula_cache", "Excel 公式没有保存的显示值；请先在 Excel 中重新计算并保存，导入不会执行公式")
				}
				inCell = false
			}
		}
		if maxRow > sourceMaxRows || maxCol > sourceMaxColumns || maxRow*maxCol > sourceMaxCells {
			return sourceTableLimit()
		}
	}
	return ctx.Err()
}

// Older BIFF readers may ignore I/O errors. Panic only within convertSource's
// recovery boundary when their input budget is exhausted, so cyclic CFB chains
// and cancellation cannot keep reading indefinitely. No recovered value is logged.
type sourceXLSReader struct {
	ctx       context.Context
	r         *bytes.Reader
	remaining int64
}

func (r *sourceXLSReader) check(n int) {
	r.remaining -= int64(n) + 1
	if r.ctx.Err() != nil || r.remaining < 0 {
		panic("source reader stopped")
	}
}
func (r *sourceXLSReader) Read(p []byte) (int, error) { r.check(len(p)); return r.r.Read(p) }
func (r *sourceXLSReader) ReadAt(p []byte, off int64) (int, error) {
	r.check(len(p))
	return r.r.ReadAt(p, off)
}
func (r *sourceXLSReader) Seek(off int64, whence int) (int64, error) {
	r.check(0)
	return r.r.Seek(off, whence)
}

type sourceXLSCell struct {
	row, col int
	value    string
}
type sourceXLSSheet struct {
	offset         int
	cells          []sourceXLSCell
	maxRow, maxCol int
}

func readXLSSheets(ctx context.Context, source string) ([]sourceEditSheet, error) {
	f, err := os.Open(source)
	if err != nil {
		return nil, sourceError("read", "无法读取 XLS 源文件")
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(sourceContextReader{ctx, f}, sourceResourceLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > sourceResourceLimit {
		return nil, sourceError("limit", "二进制 XLS 超过 32 MB 转换上限，请拆分或另存为 XLSX")
	}
	if len(data) < 512 || !bytes.Equal(data[:8], []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}) {
		return nil, sourceError("format", "文件不是有效的二进制 XLS，可能扩展名不匹配")
	}
	sectorShift := binary.LittleEndian.Uint16(data[30:32])
	if sectorShift != 9 && sectorShift != 12 {
		return nil, sourceError("corrupt", "XLS 扇区大小无效")
	}
	sectors := uint32(len(data) >> sectorShift)
	for _, offset := range []int{40, 44, 64, 72} {
		if binary.LittleEndian.Uint32(data[offset:offset+4]) > sectors {
			return nil, sourceError("corrupt", "XLS 扇区数量超出文件边界")
		}
	}
	reader := &sourceXLSReader{ctx, bytes.NewReader(data), maxImportBytes}
	container, err := mscfb.New(reader)
	if err != nil {
		return nil, sourceError("corrupt", "XLS 复合文档损坏或已加密")
	}
	var stream []byte
	if len(container.File) > 10000 {
		return nil, sourceError("limit", "XLS 复合文档资源过多")
	}
	for _, entry := range container.File {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if entry.Size < 0 || entry.Size > sourceResourceLimit {
			return nil, sourceError("limit", "XLS 单个资源超过 32 MB 上限")
		}
		if entry.Name == "EncryptedPackage" || entry.Name == "EncryptionInfo" {
			return nil, sourceError("encrypted", "不支持加密的 Excel，请先解密后导入")
		}
		if entry.Name == "Workbook" || entry.Name == "Book" {
			if stream != nil {
				return nil, sourceError("corrupt", "XLS 工作簿流重复")
			}
			stream, err = io.ReadAll(io.LimitReader(sourceContextReader{ctx, entry}, sourceResourceLimit+1))
			if err != nil || int64(len(stream)) != entry.Size {
				return nil, sourceError("corrupt", "XLS 工作簿流读取未完成")
			}
		}
	}
	if len(stream) < 8 {
		return nil, sourceError("format", "XLS 缺少有效工作簿流，不能以其他文件改名导入")
	}
	sheets, err := validateBIFF(ctx, stream)
	if err != nil {
		return nil, err
	}
	// Parse the original binary with the mature BIFF parser only after bounding
	// stream sizes, record lengths, cell coordinates and formula caches.
	reader = &sourceXLSReader{ctx, bytes.NewReader(data), maxImportBytes}
	book, err := xls.OpenReader(reader)
	if err != nil || book.GetNumberSheets() != len(sheets) {
		return nil, sourceError("corrupt", "XLS 工作簿解析未完成或格式不受支持")
	}
	var result []sourceEditSheet
	budget := 0
	for i, limits := range sheets {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		sheet, e := book.GetSheet(i)
		if e != nil {
			return nil, sourceError("corrupt", "XLS 工作表无法读取")
		}
		values := make([][]string, limits.maxRow)
		for r := range values {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			row, e := sheet.GetRow(r)
			if e != nil {
				return nil, sourceError("corrupt", "XLS 行读取失败")
			}
			values[r] = make([]string, limits.maxCol)
			for c := range values[r] {
				cell, e := row.GetCol(c)
				if e != nil {
					return nil, sourceError("corrupt", "XLS 单元格读取失败")
				}
				value := cell.GetString()
				// Custom number formats are best effort. Unformatted numeric values
				// remain readable; BIFF formula caches are supplied below.
				if cell.GetType() == "*record.Number" || cell.GetType() == "*record.Rk" {
					xf := book.GetXFbyIndex(cell.GetXFIndex())
					format := book.GetFormatByIndex(xf.GetFormatIndex())
					value = format.GetFormatString(cell)
				}
				values[r][c] = value
			}
		}
		for _, cell := range limits.cells {
			values[cell.row][cell.col] = cell.value
		}
		_, _, e = sourceTable(ctx, sheet.GetName(), values, &budget)
		if e != nil {
			return nil, e
		}
		result = append(result, sourceEditSheet{Name: sheet.GetName(), Rows: values})
	}
	return result, nil
}
func xlsChapters(ctx context.Context, source string) ([]sourceChapter, error) {
	sheets, err := readXLSSheets(ctx, source)
	if err != nil {
		return nil, err
	}
	return sourceSheetChapters(ctx, sheets, false)
}

// BIFF5/8 record preflight also fills cached formula results that xlsReader does
// not expose. It never evaluates the token stream. Unknown non-cell records
// (formatting, charts, VBA, external links) are not executed or embedded.
func validateBIFF(ctx context.Context, data []byte) ([]sourceXLSSheet, error) {
	u16 := binary.LittleEndian.Uint16
	u32 := binary.LittleEndian.Uint32
	if len(data) < 8 || u16(data[:2]) != 0x0809 || (u16(data[4:6]) != 0x0600 && u16(data[4:6]) != 0x0500) {
		return nil, sourceError("format", "仅支持 BIFF5/BIFF8 二进制 XLS 工作簿")
	}
	var sheets []sourceXLSSheet
	positions := map[int]bool{}
	for p := 0; p+4 <= len(data); {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		positions[p] = true
		if len(positions) > sourceMaxCells*3 {
			return nil, sourceError("limit", "XLS 记录数量超过转换上限")
		}
		id, n := u16(data[p:p+2]), int(u16(data[p+2:p+4]))
		p += 4
		if n > 8224 || n > len(data)-p {
			return nil, sourceError("corrupt", "XLS 记录长度无效或文件已截断")
		}
		v := data[p : p+n]
		if id == 0x00fc && (n < 8 || u32(v[4:8]) > sourceMaxCells) {
			return nil, sourceError("limit", "XLS 共享文本数量过大或记录损坏")
		}
		if id == 0x002f {
			return nil, sourceError("encrypted", "不支持加密的 XLS，请先解密后导入")
		}
		if id == 0x0085 {
			if n < 8 || v[5] != 0 {
				return nil, sourceError("format", "XLS 含非普通工作表，无法完整生成阅读副本")
			}
			sheets = append(sheets, sourceXLSSheet{offset: int(u32(v[:4]))})
			if len(sheets) > sourceMaxSheets {
				return nil, sourceError("limit", "Excel 工作表超过 64 个上限")
			}
		}
		p += n
		// Compound streams can have zero padding after their last EOF.
		if id == 0x000a && bytes.Count(data[p:], []byte{0}) == len(data)-p {
			break
		}
	}
	if len(sheets) == 0 {
		return nil, sourceError("empty", "XLS 没有可读取的工作表")
	}
	total := 0
	for i := range sheets {
		s := &sheets[i]
		if !positions[s.offset] || s.offset < 0 || s.offset+8 > len(data) || u16(data[s.offset:s.offset+2]) != 0x0809 {
			return nil, sourceError("corrupt", "XLS 工作表位置无效")
		}
		ended := false
		for p := s.offset; p+4 <= len(data); {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			id, n := u16(data[p:p+2]), int(u16(data[p+2:p+4]))
			p += 4
			if n > len(data)-p {
				return nil, sourceError("corrupt", "XLS 工作表已截断")
			}
			v := data[p : p+n]
			p += n
			if id == 0x000a {
				ended = true
				break
			}
			cell := false
			lastCol := 0
			switch id {
			case 0x0006, 0x0201, 0x0203, 0x0204, 0x0205, 0x027e, 0x00fd:
				cell = true
			case 0x00bd, 0x00be:
				cell = true
				if n < 6 {
					return nil, sourceError("corrupt", "XLS 多单元格记录损坏")
				}
				lastCol = int(u16(v[n-2:]))
			}
			if !cell {
				continue
			}
			if n < 6 {
				return nil, sourceError("corrupt", "XLS 单元格记录损坏")
			}
			r, c := int(u16(v[:2])), int(u16(v[2:4]))
			if lastCol < c {
				lastCol = c
			}
			if r+1 > s.maxRow {
				s.maxRow = r + 1
			}
			if lastCol+1 > s.maxCol {
				s.maxCol = lastCol + 1
			}
			if s.maxRow > sourceMaxRows || s.maxCol > sourceMaxColumns || s.maxRow*s.maxCol+total > sourceMaxCells {
				return nil, sourceTableLimit()
			}
			if id == 0x0006 {
				if n < 22 {
					return nil, sourceError("corrupt", "XLS 公式缓存记录损坏")
				}
				cache := v[6:14]
				value := ""
				if cache[6] == 0xff && cache[7] == 0xff {
					switch cache[0] {
					case 0:
						if p+4 > len(data) || u16(data[p:p+2]) != 0x0207 {
							return nil, sourceError("formula_cache", "XLS 公式缺少缓存文本，请在 Excel 中重新计算并保存")
						}
						ln := int(u16(data[p+2 : p+4]))
						if p+4+ln > len(data) {
							return nil, sourceError("corrupt", "XLS 公式文本已截断")
						}
						var e error
						value, e = biffCachedString(data[p+4 : p+4+ln])
						if e != nil {
							return nil, e
						}
						p += 4 + ln
					case 1:
						if cache[2] == 0 {
							value = "FALSE"
						} else {
							value = "TRUE"
						}
					case 2:
						value = "#ERROR(" + strconv.Itoa(int(cache[2])) + ")"
					case 3:
						value = ""
					default:
						return nil, sourceError("formula_cache", "XLS 公式缓存类型不受支持")
					}
				} else {
					number := math.Float64frombits(binary.LittleEndian.Uint64(cache))
					if math.IsNaN(number) || math.IsInf(number, 0) {
						return nil, sourceError("corrupt", "XLS 公式缓存数值无效")
					}
					value = strconv.FormatFloat(number, 'f', -1, 64)
				}
				s.cells = append(s.cells, sourceXLSCell{r, c, value})
			}
		}
		if !ended {
			return nil, sourceError("corrupt", "XLS 工作表没有结束记录")
		}
		total += s.maxRow * s.maxCol
	}
	return sheets, nil
}
func biffCachedString(v []byte) (string, error) {
	if len(v) < 3 {
		return "", sourceError("corrupt", "XLS 公式文本缓存损坏")
	}
	n := int(binary.LittleEndian.Uint16(v[:2]))
	flags := v[2]
	start := 3
	if flags&0x0c != 0 {
		return "", sourceError("formula_cache", "XLS 公式富文本缓存暂不支持，请另存为 XLSX")
	}
	if flags&1 == 0 {
		if start+n > len(v) {
			return "", sourceError("formula_cache", "XLS 跨记录公式文本暂不支持，请另存为 XLSX")
		}
		r := make([]rune, n)
		for i := range r {
			r[i] = rune(v[start+i])
		}
		return string(r), nil
	}
	if start+n*2 > len(v) {
		return "", sourceError("formula_cache", "XLS 跨记录公式文本暂不支持，请另存为 XLSX")
	}
	r := make([]uint16, n)
	for i := range r {
		r[i] = binary.LittleEndian.Uint16(v[start+i*2:])
	}
	return string(utf16.Decode(r)), nil
}
