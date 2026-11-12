package venues

import "testing"

// 断言中的标准写法逐字取自内置 CCF 第七版目录（含目录原文的大小写）。
func TestNormalize(t *testing.T) {
	icml := "ICML (International Conference on Machine Learning)"
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"简称精确匹配", "ICML", icml},
		{"简称忽略大小写与首尾空白", "  icml\t", icml},
		{"全称精确匹配", "International Conference on Machine Learning", icml},
		{"全称忽略大小写", "international conference on machine learning", icml},
		{"年份尾缀", "International Conference on Machine Learning 2023", icml},
		{"期刊简称", "TMC", "TMC (IEEE Transactions on Mobile Computing)"},
		{"期刊全称", "IEEE Transactions on Mobile Computing", "TMC (IEEE Transactions on Mobile Computing)"},
		{"ASPLOS proceedings 长串",
			"Proceedings of the 29th ACM International Conference on Architectural Support for Programming Languages and Operating Systems",
			"ASPLOS (International Conference on Architectural Support for Programming Languages and Operating Systems)"},
		{"SC 含逗号全称",
			"International Conference for High Performance Computing, Networking, Storage, and Analysis",
			"SC (International Conference for High Performance Computing, Networking, Storage, and Analysis)"},
		{"NeurIPS 简称", "NeurIPS", "NeurIPS (Conference on Neural Information Processing Systems)"},
		{"NeurIPS Advances 卷名", "Advances in Neural Information Processing Systems 32",
			"NeurIPS (Conference on Neural Information Processing Systems)"},
		{"NIPS 旧称", "NIPS", "NeurIPS (Conference on Neural Information Processing Systems)"},
		{"NeurIPS 卷名不带 Conference", "Neural Information Processing Systems",
			"NeurIPS (Conference on Neural Information Processing Systems)"},
		{"ACL 长串带卷号与 Long Papers",
			"Proceedings of the 58th Annual Meeting of the Association for Computational Linguistics, Volume 1: Long Papers",
			"ACL (Annual Meeting of the Association for Computational Linguistics)"},
		{"IJCNN 全称", "International Joint Conference on Neural Networks",
			"IJCNN (International Joint Conference on Neural Networks)"},
		{"TNNLS 容忍输入与目录的大小写差异", "IEEE Transactions on Neural Networks and Learning Systems",
			"TNNLS (IEEE Transactions on Neural Networks and learning systems)"},
		{"无简称条目只返回全称", "Networks", "Networks"},
		{"arXiv 简写", "arXiv", "arXiv (preprint)"},
		{"arXiv.org", "arXiv.org", "arXiv (preprint)"},
		{"arXiv preprint", "arXiv preprint", "arXiv (preprint)"},
		{"ICMLA 不误归 ICML",
			"International Conference on Machine Learning and Applications",
			"International Conference on Machine Learning and Applications"},
		{"Asia-Pacific 不误归 ICML",
			"Asia-Pacific Conference on Machine Learning",
			"Asia-Pacific Conference on Machine Learning"},
		{"歧义简称 SEC 原样返回", "SEC", "SEC"},
		{"未知名称原样返回", "Journal of NeoRead Studies", "Journal of NeoRead Studies"},
		{"空串", "", ""},
		{"仅空白", "   ", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Normalize(tt.in); got != tt.want {
				t.Fatalf("Normalize(%q)\n got  %q\n want %q", tt.in, got, tt.want)
			}
		})
	}
}
