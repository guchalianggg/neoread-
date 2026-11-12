package neoread

import "unicode"

// chineseSampleFloor is the smallest body sample that may decide a language.
// A shorter layout stays unconcluded, because one Chinese abstract inside an
// English paper must not decide the whole document.
const chineseSampleFloor = 200

// chineseSharePercent is the share of Han characters, among all letters, that
// marks a document as written in Chinese. The translation target is Simplified
// Chinese, so such documents gain nothing from translation. The threshold sits
// below one half so that heavy English citations do not hide a Chinese body.
const chineseSharePercent = 40

// predominantlyChinese reports whether a parsed layout is written in Chinese.
// It only reads the parsed text, so it works for scanned documents as soon as
// the layout pass produced a text layer.
func predominantlyChinese(m layoutManifest) bool {
	han, letters := 0, 0
	for _, b := range m.Blocks {
		for _, r := range b.Text {
			switch {
			case unicode.Is(unicode.Han, r):
				han++
				letters++
			case unicode.IsLetter(r):
				letters++
			}
		}
	}
	return letters >= chineseSampleFloor && han*100 >= letters*chineseSharePercent
}
