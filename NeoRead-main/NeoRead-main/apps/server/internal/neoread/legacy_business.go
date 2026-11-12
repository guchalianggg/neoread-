package neoread

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// This is the one-time Reader -> NeoRead data selection. Chromium's profile and
// integration files are outside it, regardless of their current or future names.
// A custom library is selected by its saved location, not by its folder name.
func (state *ReaderMigration) dataPaths() map[string]bool {
	paths := map[string]bool{"library": true, "library-location.json": false, "proxy-settings.json": false}
	if !state.External && state.SourceLibrary != state.Source {
		if rel, err := filepath.Rel(state.Source, state.SourceLibrary); err == nil && filepath.IsLocal(rel) {
			paths[rel] = true
		}
	}
	for name := range paths {
		for parent, directory := range paths {
			if directory && parent != name && containsPath(parent, name) {
				delete(paths, name)
				break
			}
		}
	}
	return paths
}

func libraryRuntimeFile(rel string) bool {
	switch rel {
	case "reader.lock", "neoread.lock", "server.json", "ai-work":
		return true
	}
	return strings.HasPrefix(rel, "ai-work"+string(os.PathSeparator))
}

func (state *ReaderMigration) businessExcluded(rel string) bool {
	for root, directory := range state.dataPaths() {
		if rel == root {
			return false
		}
		if directory && containsPath(root, rel) {
			inner, _ := filepath.Rel(root, rel)
			return libraryRuntimeFile(inner)
		}
		if containsPath(rel, root) {
			return false
		}
	}
	return true
}

func (state *ReaderMigration) checkDataPaths() error {
	selected, err := oldLibrary(state.Source)
	if err != nil {
		return err
	}
	if pathExists(selected) {
		selected, err = realDirectory(selected)
		if err != nil {
			return err
		}
	}
	if selected != state.SourceLibrary {
		return migrationErrorf("source_location_changed", "旧书库位置在迁移期间发生变化，请检查后重试")
	}
	if state.SourceLibrary == state.Source {
		return migrationErrorf("overlapping_library", "旧书库与应用运行目录重叠，请先将书库放到独立目录")
	}
	for name, directory := range state.dataPaths() {
		info, err := os.Lstat(filepath.Join(state.Source, name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if directory && !info.IsDir() || !directory && !info.Mode().IsRegular() {
			return migrationErrorf("invalid_data_path", "旧业务数据路径不是预期的文件或目录：%s", name)
		}
	}
	return nil
}

// Hash only selected units, using their configured names rather than the case
// returned by the filesystem. Unselected profile entries are never inspected.
func (state *ReaderMigration) businessDigest(root string) (string, int64, error) {
	hash := sha256.New()
	var size int64
	paths := state.dataPaths()
	for _, name := range sortedDataPaths(paths) {
		path := filepath.Join(root, name)
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return "", size, err
		}
		if paths[name] != info.IsDir() || (!info.IsDir() && !info.Mode().IsRegular()) {
			return "", size, migrationErrorf("invalid_data_path", "业务数据路径类型发生变化：%s", name)
		}
		var digest string
		if info.IsDir() {
			var bytes int64
			digest, bytes, err = treeDigestWithPolicy(path, libraryRuntimeFile)
			size += bytes
		} else {
			digest, err = digestEntry(path)
			size += info.Size()
		}
		if err != nil {
			return "", size, err
		}
		fmt.Fprintf(hash, "%t:%s:%s\x00", info.IsDir(), name, digest)
	}
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}

func digestBusinessEntry(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		hash, _, err := treeDigestWithPolicy(path, libraryRuntimeFile)
		return hash, err
	}
	return digestEntry(path)
}

func (state *ReaderMigration) libraryExcluded(rel string) bool {
	if state.DataOnly {
		return libraryRuntimeFile(rel)
	}
	return migrationExcluded(rel)
}

func (state *ReaderMigration) libraryDigest(path string) (string, int64, error) {
	return treeDigestWithPolicy(path, state.libraryExcluded)
}

func (state *ReaderMigration) activationDigest(path string) (string, error) {
	if state.DataOnly {
		return digestBusinessEntry(path)
	}
	return digestEntry(path)
}

func sortedDataPaths(paths map[string]bool) []string {
	names := make([]string, 0, len(paths))
	for name := range paths {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Move only copied data, keeping the library lock in place. In particular this
// never renames Reader's application directory or a locked library directory.
// That keeps Chromium and existing Word/WPS clients away from the cleanup.
func removeReaderBusinessData(source string, state *ReaderMigration, expectedHash string) error {
	quarantine := filepath.Join(filepath.Dir(source), ".reader-cleanup-"+state.ID)
	if pathExists(quarantine) {
		return migrationErrorf("cleanup_interrupted", "清理临时目录已存在，旧数据保留在 %s，请检查后手动处理", quarantine)
	}
	if err := os.Mkdir(quarantine, 0700); err != nil {
		return err
	}
	type movedPath struct{ from, to string }
	moved := []movedPath{}
	fail := func(cause error) error {
		restored := true
		for i := len(moved) - 1; i >= 0; i-- {
			item := moved[i]
			if pathExists(item.from) || os.Rename(item.to, item.from) != nil {
				restored = false
			}
		}
		if restored {
			_ = os.RemoveAll(quarantine)
			return cause
		}
		return fmt.Errorf("清理未完成，旧数据保留在 %s：%w", quarantine, cause)
	}
	move := func(rel string) error {
		from, to := filepath.Join(source, rel), filepath.Join(quarantine, rel)
		if err := os.MkdirAll(filepath.Dir(to), 0700); err != nil {
			return err
		}
		if err := os.Rename(from, to); err != nil {
			return err
		}
		moved = append(moved, movedPath{from, to})
		return nil
	}
	for _, name := range sortedDataPaths(state.dataPaths()) {
		path := filepath.Join(source, name)
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return fail(err)
		}
		if !info.IsDir() {
			if err = move(name); err != nil {
				return fail(err)
			}
			continue
		}
		if err = os.MkdirAll(filepath.Join(quarantine, name), 0700); err != nil {
			return fail(err)
		}
		entries, err := os.ReadDir(path)
		if err != nil {
			return fail(err)
		}
		for _, entry := range entries {
			if libraryRuntimeFile(entry.Name()) {
				continue
			}
			if err = move(filepath.Join(name, entry.Name())); err != nil {
				return fail(err)
			}
		}
	}
	hash, _, err := state.businessDigest(quarantine)
	if err != nil {
		return fail(err)
	}
	if hash != expectedHash {
		return fail(migrationErrorf("source_changed", "旧阅读数据在清理期间发生变化，未删除"))
	}
	if err := os.RemoveAll(quarantine); err != nil {
		return fmt.Errorf("部分旧数据仍在 %s，请手动处理：%w", quarantine, err)
	}
	_ = os.Remove(source)
	return nil
}
