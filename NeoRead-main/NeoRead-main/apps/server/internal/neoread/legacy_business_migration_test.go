package neoread

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestReaderMigrationOnlyCopiesBusinessData(t *testing.T) {
	old, current, _ := legacyFixture(t, false)
	for _, name := range []string{"GrShaderCache", "ShaderCache", "FutureChromiumDirectory2099", "Local Storage", "user-backup"} {
		writeMigrationCache(t, old, name, "old unrelated data")
		writeMigrationCache(t, current, name, "new runtime data")
	}
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(state)
	var fields map[string]any
	json.Unmarshal(encoded, &fields)
	if fields["dataOnly"] != true {
		t.Fatal("new migration must use the business-data allowlist")
	}
	if len(state.Entries) != 3 {
		t.Fatal("unexpected activation entries")
	}
	assertMigrated(t, state.Library)
	for _, name := range []string{"GrShaderCache", "ShaderCache", "FutureChromiumDirectory2099", "Local Storage", "user-backup"} {
		if _, found := state.Entries[name]; found {
			t.Fatal("unrelated profile data in activation manifest")
		}
		b, err := os.ReadFile(filepath.Join(current, name, "cache"))
		if err != nil || string(b) != "new runtime data" {
			t.Fatal("changed live profile data")
		}
		if pathExists(filepath.Join(current, migrationStage, "app", name)) {
			t.Fatal("copied profile data into staging")
		}
		writeMigrationCache(t, old, name, "profile changed after migration")
	}
	if _, err := CleanupReaderData(old, current, "delete"); err != nil {
		t.Fatal(err)
	}
	if pathExists(filepath.Join(old, "library", "reader.sqlite")) || pathExists(filepath.Join(old, "proxy-settings.json")) {
		t.Fatal("did not clean migrated data")
	}
	if !pathExists(filepath.Join(old, "user-backup", "cache")) {
		t.Fatal("deleted data outside the allowlist")
	}
}

func TestReaderMigrationResumesOldVerifiedProfileWithoutActivatingIt(t *testing.T) {
	old, current, _ := legacyFixture(t, false)
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(state)
	var fields map[string]json.RawMessage
	json.Unmarshal(encoded, &fields)
	delete(fields, "dataOnly")
	encoded, _ = json.Marshal(fields)
	state = new(ReaderMigration)
	if err := json.Unmarshal(encoded, state); err != nil {
		t.Fatal(err)
	}
	state.DigestVersion = 1
	for _, name := range []string{"GrShaderCache", "ShaderCache", "FutureChromiumDirectory2099"} {
		writeMigrationCache(t, old, name, "old profile")
		writeMigrationCache(t, filepath.Join(current, migrationStage, "app"), name, "old profile")
		writeMigrationCache(t, current, name, "active profile")
		state.Entries[name], _, err = treeDigest(filepath.Join(old, name))
		if err != nil {
			t.Fatal(err)
		}
	}
	state.SourceHash, _, err = state.treeDigest(old)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(current, "proxy-settings.json"), filepath.Join(current, migrationStage, "app", "proxy-settings.json")); err != nil {
		t.Fatal(err)
	}
	file, _, err := readMigration(current)
	if err != nil {
		t.Fatal(err)
	}
	state.Status, state.CompletedAt, state.LegacyCleanup = "verified", "", nil
	if err := saveMigration(current, file, state); err != nil {
		t.Fatal(err)
	}
	state, err = MigrateReaderData(old, current)
	if err != nil || state.Status != "completed" {
		t.Fatal(state, err)
	}
	assertMigrated(t, state.Library)
	for _, name := range []string{"GrShaderCache", "ShaderCache", "FutureChromiumDirectory2099"} {
		b, err := os.ReadFile(filepath.Join(current, name, "cache"))
		if err != nil || string(b) != "active profile" {
			t.Fatal("modified an old profile collision")
		}
	}
	if _, err := CleanupReaderData(old, current, "delete"); err != nil {
		t.Fatal(err)
	}
	if !pathExists(filepath.Join(old, "FutureChromiumDirectory2099")) {
		t.Fatal("cleaned unselected profile data")
	}
}

func TestReaderMigrationSelectsNestedLibraryWithoutItsSiblings(t *testing.T) {
	old, current, lib := legacyFixture(t, false)
	custom := filepath.Join(old, "custom", "reading")
	if err := os.MkdirAll(filepath.Dir(custom), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(lib, custom); err != nil {
		t.Fatal(err)
	}
	if err := atomicMigrationJSON(filepath.Join(old, "library-location.json"), map[string]string{"directory": custom}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(old, "custom", "private-note.txt"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(current, "custom"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(current, "custom", "runtime-state"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	assertMigrated(t, state.Library)
	if pathExists(filepath.Join(current, "custom", "private-note.txt")) {
		t.Fatal("copied an unselected sibling")
	}
	if !pathExists(filepath.Join(current, "custom", "runtime-state")) {
		t.Fatal("overwrote target sibling")
	}
	if _, err := CleanupReaderData(old, current, "delete"); err != nil {
		t.Fatal(err)
	}
	if !pathExists(filepath.Join(old, "custom", "private-note.txt")) {
		t.Fatal("deleted an unselected sibling")
	}
}

func TestReaderMigrationDoesNotTraverseUnselectedProfileLinks(t *testing.T) {
	old, current, _ := legacyFixture(t, false)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "private.txt"), []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(old, "UnknownProfileData")
	if err := os.Symlink(outside, link); err != nil {
		t.Skip(err)
	}
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	if pathExists(filepath.Join(current, "UnknownProfileData")) {
		t.Fatal("copied an unselected profile link")
	}
	if _, err = CleanupReaderData(old, current, "delete"); err != nil {
		t.Fatal(err)
	}
	if !pathExists(link) || !pathExists(filepath.Join(outside, "private.txt")) {
		t.Fatal("changed data outside selected paths")
	}
	assertMigrated(t, state.Library)
}

func TestReaderMigrationRestartsOldCopyUsingBusinessSelection(t *testing.T) {
	old, current, lib := legacyFixture(t, false)
	database := filepath.Join(lib, "reader.sqlite")
	original, err := os.ReadFile(database)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(database, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = MigrateReaderData(old, current); err == nil {
		t.Fatal("accepted broken database")
	}
	file, state, err := readMigration(current)
	if err != nil {
		t.Fatal(err)
	}
	state.DataOnly = false
	state.DigestVersion = 1
	if err = saveMigration(current, file, state); err != nil {
		t.Fatal(err)
	}
	writeMigrationCache(t, filepath.Join(current, migrationStage, "app"), "GrShaderCache", "old unfinished copy")
	writeMigrationCache(t, old, "GrShaderCache", "old cache")
	writeMigrationCache(t, current, "GrShaderCache", "live cache")
	if err = os.WriteFile(database, original, 0600); err != nil {
		t.Fatal(err)
	}
	state, err = MigrateReaderData(old, current)
	if err != nil || !state.DataOnly {
		t.Fatal(state, err)
	}
	if pathExists(filepath.Join(current, migrationStage, "app", "GrShaderCache")) {
		t.Fatal("kept copying unselected profile data")
	}
	assertMigrated(t, state.Library)
}

func TestReaderMigrationCopiesWholeExternalBusinessLibrary(t *testing.T) {
	old, current, lib := legacyFixture(t, true)
	writeMigrationCache(t, lib, "GrShaderCache", "data inside the selected library")
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(state.Library, "GrShaderCache", "cache"))
	if err != nil || string(data) != "data inside the selected library" {
		t.Fatal("applied a browser cache blacklist inside the selected library")
	}
}

func TestReaderCleanupPreservesInterruptedQuarantine(t *testing.T) {
	old, current, _ := legacyFixture(t, false)
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	quarantine := filepath.Join(filepath.Dir(old), ".reader-cleanup-"+state.ID)
	if err := os.Rename(old, quarantine); err != nil {
		t.Fatal(err)
	}
	_, err = CleanupReaderData(old, current, "delete")
	if err == nil || migrationFailureReason(err) != "cleanup_interrupted" {
		t.Fatal("must report quarantined data even when the old directory is missing", err)
	}
	if !pathExists(filepath.Join(quarantine, "library", "reader.sqlite")) {
		t.Fatal("deleted interrupted cleanup data")
	}
	_, saved, err := readMigration(current)
	if err != nil || saved.LegacyCleanup.Status != "failed" {
		t.Fatal("incorrectly marked interrupted cleanup complete", err)
	}
}
