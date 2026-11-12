package neoread

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofrs/flock"
)

func legacyFixture(t *testing.T, external bool) (string, string, string) {
	t.Helper()
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old, current := filepath.Join(parent, "Reader"), filepath.Join(parent, "NeoRead")
	lib := filepath.Join(old, "library")
	if external {
		lib = filepath.Join(parent, "My papers")
	}
	if err = os.MkdirAll(old, 0700); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(lib)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec(`INSERT INTO settings VALUES('reader','{"appearance":"dark"}'); INSERT INTO settings VALUES('connector:secret','paired'); INSERT INTO documents(id,type,title,author,size,created_at,last_opened_at,percentage) VALUES('paper','pdf','Paper','Author',3,'now','now',0.5); INSERT INTO document_notes VALUES('paper','my note','now'); INSERT INTO annotations VALUES('mark','paper','{"text":"keep"}');`); err != nil {
		t.Fatal(err)
	}
	if err = s.DB.Close(); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(lib, "papers", "paper.pdf"), []byte("pdf"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(filepath.Join(lib, "neoread.sqlite"), filepath.Join(lib, "reader.sqlite")); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(old, "proxy-settings.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if external {
		if err = atomicMigrationJSON(filepath.Join(old, "library-location.json"), map[string]string{"directory": lib}); err != nil {
			t.Fatal(err)
		}
	}
	return old, current, lib
}
func assertMigrated(t *testing.T, root string) {
	t.Helper()
	s, err := OpenStore(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	for key, want := range map[string]string{"neoread": "{\"appearance\":\"dark\"}", "connector:secret": "paired"} {
		var got string
		if err = s.DB.QueryRow("SELECT value FROM settings WHERE key=?", key).Scan(&got); err != nil || got != want {
			t.Fatal(key, got, err)
		}
	}
	var note string
	if err = s.DB.QueryRow("SELECT body FROM document_notes WHERE document_id='paper'").Scan(&note); err != nil || note != "my note" {
		t.Fatal(note, err)
	}
	if data, err := os.ReadFile(filepath.Join(root, "papers", "paper.pdf")); err != nil || string(data) != "pdf" {
		t.Fatal(string(data), err)
	}
}
func TestReaderMigrationCopiesDefaultAndExternalOnce(t *testing.T) {
	for _, external := range []bool{false, true} {
		t.Run(map[bool]string{false: "default", true: "external"}[external], func(t *testing.T) {
			old, current, lib := legacyFixture(t, external)
			before, _, _ := treeDigest(old)
			state, err := MigrateReaderData(old, current)
			if err != nil {
				t.Fatal(err)
			}
			if state.Status != "completed" || state.LegacyCleanup.Status != "pending" {
				t.Fatal(state)
			}
			assertMigrated(t, state.Library)
			after, _, _ := treeDigest(old)
			if before != after || !pathExists(filepath.Join(lib, "reader.sqlite")) {
				t.Fatal("source modified")
			}
			// An updated application must not replay the old library over new edits.
			if err = os.WriteFile(filepath.Join(state.Library, "papers", "paper.pdf"), []byte("new"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err = MigrateReaderData(old, current); err != nil {
				t.Fatal(err)
			}
			data, _ := os.ReadFile(filepath.Join(state.Library, "papers", "paper.pdf"))
			if string(data) != "new" {
				t.Fatal("repeated migration")
			}
		})
	}
}
func TestReaderMigrationFreshAndExistingInstallAreTerminal(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	old, current := filepath.Join(root, "Reader"), filepath.Join(root, "NeoRead")
	state, err := MigrateReaderData(old, current)
	if err != nil || state.Status != "not-needed" {
		t.Fatal(state, err)
	}
	os.MkdirAll(filepath.Join(old, "library"), 0700)
	state, err = MigrateReaderData(old, current)
	if err != nil || state.Reason != "fresh-install" {
		t.Fatal(state, err)
	}
	old, current, _ = legacyFixture(t, false)
	os.MkdirAll(filepath.Join(current, "library"), 0700)
	state, err = MigrateReaderData(old, current)
	if err != nil || state.Reason != "existing-install" {
		t.Fatal(state, err)
	}
}
func TestReaderMigrationFailsClosedForInvalidPointerAndOfflineDrive(t *testing.T) {
	for _, pointer := range []string{"invalid", `{"directory":"relative"}`, `{"directory":"/missing/drive/books"}`} {
		old, current, _ := legacyFixture(t, false)
		os.WriteFile(filepath.Join(old, "library-location.json"), []byte(pointer), 0600)
		if _, err := MigrateReaderData(old, current); err == nil {
			t.Fatal("accepted", pointer)
		}
		if pathExists(filepath.Join(current, "library")) {
			t.Fatal("started empty library")
		}
	}
}
func TestReaderMigrationRequiresOldLibraryLock(t *testing.T) {
	old, current, lib := legacyFixture(t, false)
	lock := flock.New(filepath.Join(lib, "reader.lock"))
	if err := lock.Lock(); err != nil {
		t.Fatal(err)
	}
	if _, err := MigrateReaderData(old, current); err == nil {
		t.Fatal("migrated a running library")
	}
	lock.Unlock()
	if _, err := MigrateReaderData(old, current); err != nil {
		t.Fatal(err)
	}
}
func TestReaderMigrationRefusesCorruptStateAndDestinationCollision(t *testing.T) {
	old, current, lib := legacyFixture(t, true)
	os.MkdirAll(filepath.Join(filepath.Dir(lib), "NeoRead Library"), 0700)
	if _, err := MigrateReaderData(old, current); err == nil {
		t.Fatal("overwrote destination")
	}
	os.WriteFile(filepath.Join(current, "migrations.json"), []byte("broken"), 0600)
	if _, err := MigrateReaderData(old, current); err == nil {
		t.Fatal("ignored corrupt state")
	}
}
func TestReaderMigrationKeepsUncheckpointedWAL(t *testing.T) {
	old, current, lib := legacyFixture(t, false)
	db, err := sql.Open("sqlite", libraryDatabaseURI(filepath.Join(lib, "reader.sqlite")))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO settings VALUES('wal-only','committed')"); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(lib, "reader.sqlite-wal")); err != nil || info.Size() == 0 {
		t.Fatal("no WAL fixture", err)
	}
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(state.Library)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	var got string
	if err = s.DB.QueryRow("SELECT value FROM settings WHERE key='wal-only'").Scan(&got); err != nil || got != "committed" {
		t.Fatal(got, err)
	}
}
func TestReaderMigrationResumesAfterActivationBeforeCompletion(t *testing.T) {
	old, current, _ := legacyFixture(t, true)
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	file, _, _ := readMigration(current)
	state.Status = "verified"
	state.LegacyCleanup = nil
	if err = saveMigration(current, file, state); err != nil {
		t.Fatal(err)
	}
	state, err = MigrateReaderData(old, current)
	if err != nil || state.Status != "completed" {
		t.Fatal(state, err)
	}
	assertMigrated(t, state.Library)
}
func TestReaderMigrationRestartsInterruptedCopy(t *testing.T) {
	old, current, _ := legacyFixture(t, false)
	// Stop conversion after an otherwise complete directory copy.
	os.WriteFile(filepath.Join(old, "library", "reader.sqlite"), []byte("corrupt"), 0600)
	if _, err := MigrateReaderData(old, current); err == nil {
		t.Fatal("accepted corrupt DB")
	}
	file, state, err := readMigration(current)
	if err != nil || state.Status != "copying" {
		t.Fatal(state, err)
	}
	if len(file.Migrations) != 1 {
		t.Fatal(file)
	}
	// The source is untouched, and no incomplete library has been activated.
	if pathExists(filepath.Join(current, "library")) {
		t.Fatal("activated incomplete library")
	}
}
func TestReaderCleanupRequiresExplicitChoiceAndPreservesExternalLibrary(t *testing.T) {
	old, current, lib := legacyFixture(t, true)
	_, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	state, err := CleanupReaderData(old, current, "delete")
	if err != nil {
		t.Fatal(err)
	}
	if state.LegacyCleanup.Status != "deleted" || pathExists(old) || !pathExists(filepath.Join(lib, "reader.sqlite")) {
		t.Fatal("wrong deletion boundary")
	}
	if _, err = MigrateReaderData(old, current); err != nil {
		t.Fatal(err)
	}
}
func TestReaderCleanupKeepAndChangedSourceAreNeverRetried(t *testing.T) {
	for _, choice := range []string{"keep", "delete"} {
		old, current, _ := legacyFixture(t, false)
		_, err := MigrateReaderData(old, current)
		if err != nil {
			t.Fatal(err)
		}
		if choice == "delete" {
			os.WriteFile(filepath.Join(old, "library", "new-note"), []byte("do not delete"), 0600)
		}
		_, err = CleanupReaderData(old, current, choice)
		if choice == "delete" && err == nil {
			t.Fatal("deleted changed source")
		}
		if !pathExists(old) {
			t.Fatal("deleted original")
		}
		_, state, err := readMigration(current)
		if err != nil || state.LegacyCleanup.Status == "pending" {
			t.Fatal(state, err)
		}
		if _, err = CleanupReaderData(old, current, "delete"); err != nil {
			t.Fatal(err)
		}
		if !pathExists(old) {
			t.Fatal("retried cleanup")
		}
	}
}
func TestReaderMigrationPreservesOtherMigrationRecords(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	current := filepath.Join(root, "NeoRead")
	os.MkdirAll(current, 0700)
	atomicMigrationJSON(filepath.Join(current, "migrations.json"), migrationFile{SchemaVersion: 1, Migrations: map[string]json.RawMessage{"future": json.RawMessage(`{"status":"completed"}`)}})
	if _, err := MigrateReaderData(filepath.Join(root, "Reader"), current); err != nil {
		t.Fatal(err)
	}
	file, _, _ := readMigration(current)
	if len(file.Migrations) != 2 {
		t.Fatal(file)
	}
}

func TestReaderMigrationResumesPartiallyInstalledEntries(t *testing.T) {
	old, current, _ := legacyFixture(t, false)
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(current, migrationStage, "app")
	if err = os.Rename(filepath.Join(current, "proxy-settings.json"), filepath.Join(stage, "proxy-settings.json")); err != nil {
		t.Fatal(err)
	}
	file, _, _ := readMigration(current)
	state.Status = "verified"
	saveMigration(current, file, state)
	state, err = MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	if !pathExists(filepath.Join(current, "proxy-settings.json")) {
		t.Fatal("did not finish installation")
	}
	assertMigrated(t, state.Library)
}
func TestReaderMigrationRetriesCopyAfterFailure(t *testing.T) {
	old, current, lib := legacyFixture(t, false)
	database := filepath.Join(lib, "reader.sqlite")
	original, _ := os.ReadFile(database)
	os.WriteFile(database, []byte("bad database"), 0600)
	if _, err := MigrateReaderData(old, current); err == nil {
		t.Fatal("accepted broken database")
	}
	os.WriteFile(database, original, 0600)
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	assertMigrated(t, state.Library)
}
func TestReaderMigrationHandlesInternalCustomLibrary(t *testing.T) {
	old, current, lib := legacyFixture(t, false)
	custom := filepath.Join(old, "custom")
	if err := os.Rename(lib, custom); err != nil {
		t.Fatal(err)
	}
	atomicMigrationJSON(filepath.Join(old, "library-location.json"), map[string]string{"directory": custom})
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	if state.External || state.Library != filepath.Join(current, "custom") {
		t.Fatal(state)
	}
	assertMigrated(t, state.Library)
}
func TestReaderMigrationRefusesMissingOriginalFile(t *testing.T) {
	old, current, lib := legacyFixture(t, false)
	os.Remove(filepath.Join(lib, "papers", "paper.pdf"))
	if _, err := MigrateReaderData(old, current); err == nil {
		t.Fatal("accepted missing original file")
	}
	if pathExists(filepath.Join(current, "library")) {
		t.Fatal("activated incomplete data")
	}
}
func TestReaderMigrationRejectsSymlinks(t *testing.T) {
	old, current, _ := legacyFixture(t, false)
	if err := os.Symlink(t.TempDir(), filepath.Join(old, "library", "linked-data")); err != nil {
		t.Skip(err)
	}
	if _, err := MigrateReaderData(old, current); err == nil {
		t.Fatal("followed symlink")
	}
}
func TestReaderCleanupProtectsActiveLibraryAndRunningReader(t *testing.T) {
	for _, running := range []bool{false, true} {
		old, current, lib := legacyFixture(t, false)
		if _, err := MigrateReaderData(old, current); err != nil {
			t.Fatal(err)
		}
		if running {
			lock := flock.New(filepath.Join(lib, "reader.lock"))
			if err := lock.Lock(); err != nil {
				t.Fatal(err)
			}
			defer lock.Unlock()
		} else {
			atomicMigrationJSON(filepath.Join(current, "library-location.json"), map[string]string{"directory": lib})
		}
		if _, err := CleanupReaderData(old, current, "delete"); err == nil {
			t.Fatal("unsafe cleanup accepted")
		}
		if !pathExists(filepath.Join(lib, "reader.sqlite")) {
			t.Fatal("deleted active database")
		}
	}
}
func TestExistingNeoReadDatabaseRenamesWithoutImportingReader(t *testing.T) {
	old, current, lib := legacyFixture(t, false)
	if err := os.Rename(old, current); err != nil {
		t.Fatal(err)
	}
	lib = filepath.Join(current, "library")
	state, err := MigrateReaderData(old, current)
	if err != nil || state.Reason != "existing-install" {
		t.Fatal(state, err)
	}
	unlock, err := LockLibrary(lib)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	assertMigrated(t, lib)
	if !pathExists(filepath.Join(lib, "reader.sqlite")) {
		t.Fatal("removed existing database backup")
	}
}

func TestReaderMigrationAcceptsOlderSchemaWithoutCorpusTable(t *testing.T) {
	old, current, lib := legacyFixture(t, false)
	db, err := sql.Open("sqlite", libraryDatabaseURI(filepath.Join(lib, "reader.sqlite")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("DROP TABLE document_corpora"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	assertMigrated(t, state.Library)
}
func TestReaderMigrationPreservesValidCorpusFingerprint(t *testing.T) {
	old, current, lib := legacyFixture(t, false)
	server := &Server{Store: &Store{Root: lib}}
	fingerprint, err := server.corpusFingerprint(Document{ID: "paper", Type: "pdf"})
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", libraryDatabaseURI(filepath.Join(lib, "reader.sqlite")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO document_corpora(document_id,revision,fingerprint,body) VALUES('paper','revision',?,'{}')", fingerprint); err != nil {
		t.Fatal(err)
	}
	db.Close()
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(state.Library)
	if err != nil {
		t.Fatal(err)
	}
	defer store.DB.Close()
	var actual string
	store.DB.QueryRow("SELECT fingerprint FROM document_corpora WHERE document_id='paper'").Scan(&actual)
	server.Store = store
	expected, err := server.corpusFingerprint(Document{ID: "paper", Type: "pdf"})
	if err != nil {
		t.Fatal(err)
	}
	if actual != expected || actual == fingerprint {
		t.Fatal("corpus path not rebound", actual, expected)
	}
}

func TestReaderMigrationRejectsIncompleteVerifiedAndCompletedRecords(t *testing.T) {
	for _, status := range []string{"verified", "completed"} {
		old, current, _ := legacyFixture(t, false)
		state, err := MigrateReaderData(old, current)
		if err != nil {
			t.Fatal(err)
		}
		file, _, _ := readMigration(current)
		state.Status = status
		state.Entries = nil
		if err = saveMigration(current, file, state); err != nil {
			t.Fatal(err)
		}
		if _, err = MigrateReaderData(old, current); err == nil {
			t.Fatal("accepted incomplete state", status)
		}
	}
}

func TestReaderMigrationKeepsStartupDiagnosticsSeparate(t *testing.T) {
	old, current, _ := legacyFixture(t, false)
	for _, root := range []string{old, current} {
		if err := os.MkdirAll(filepath.Join(root, ".migration-logs"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, ".migration-logs", "desktop-session.jsonl"), []byte(root), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	defer slog.SetDefault(previous)
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	if _, included := state.Entries[".migration-logs"]; included {
		t.Fatal("startup logs included in activation")
	}
	data, err := os.ReadFile(filepath.Join(current, ".migration-logs", "desktop-session.jsonl"))
	if err != nil || string(data) != current {
		t.Fatal("startup logs overwritten", err)
	}
	if !strings.Contains(output.String(), "migration.finish") {
		t.Fatal(output.String())
	}
}

func TestReaderMigrationLogsFailurePhaseWithoutSourceContent(t *testing.T) {
	old, current, lib := legacyFixture(t, false)
	if err := os.WriteFile(filepath.Join(lib, "reader.sqlite"), []byte("PRIVATE_DOCUMENT_SENTINEL"), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	defer slog.SetDefault(previous)
	if _, err := MigrateReaderData(old, current); err == nil {
		t.Fatal("accepted corrupt database")
	}
	log := output.String()
	if !strings.Contains(log, `"msg":"migration.failed","phase":"convert_database"`) {
		t.Fatal(log)
	}
	if strings.Contains(log, "PRIVATE_DOCUMENT_SENTINEL") || strings.Contains(log, old) {
		t.Fatal("private source in logs")
	}
}

func writeMigrationCache(t *testing.T, root, name, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, name), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, name, "cache"), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestReaderMigrationIgnoresChromiumStartupCaches(t *testing.T) {
	old, current, _ := legacyFixture(t, false)
	for _, name := range []string{"GPUPersistentCache", "GraphiteDawnCache"} {
		writeMigrationCache(t, old, name, "old cache")
		writeMigrationCache(t, current, name, "new Chromium cache")
	}
	before, _, err := treeDigest(old)
	if err != nil {
		t.Fatal(err)
	}
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	assertMigrated(t, state.Library)
	for _, name := range []string{"GPUPersistentCache", "GraphiteDawnCache"} {
		if _, found := state.Entries[name]; found || pathExists(filepath.Join(current, migrationStage, "app", name)) {
			t.Fatal("copied runtime cache", name)
		}
		data, err := os.ReadFile(filepath.Join(current, name, "cache"))
		if err != nil || string(data) != "new Chromium cache" {
			t.Fatal("overwrote live cache", name, err)
		}
	}
	after, _, err := treeDigest(old)
	if err != nil || before != after {
		t.Fatal("modified source", err)
	}
	// Cleanup must use the same hash policy as this migration.
	if _, err := CleanupReaderData(old, current, "delete"); err != nil {
		t.Fatal(err)
	}
}

func TestReaderMigrationResumesVerifiedWithLegacyCaches(t *testing.T) {
	for _, external := range []bool{false, true} {
		for _, location := range []string{"staged", "installed", "missing"} {
			t.Run(fmt.Sprintf("external=%v/%s", external, location), func(t *testing.T) {
				old, current, _ := legacyFixture(t, external)
				state, err := MigrateReaderData(old, current)
				if err != nil {
					t.Fatal(err)
				}
				// Recreate a v0.9.0 verified journal: unversioned hashes include caches.
				encoded, _ := json.Marshal(state)
				var fields map[string]json.RawMessage
				json.Unmarshal(encoded, &fields)
				delete(fields, "digestVersion")
				delete(fields, "dataOnly")
				encoded, _ = json.Marshal(fields)
				state = new(ReaderMigration)
				if err := json.Unmarshal(encoded, state); err != nil {
					t.Fatal(err)
				}
				for _, name := range []string{"GPUPersistentCache", "GraphiteDawnCache"} {
					writeMigrationCache(t, old, name, "legacy cache")
					hash, _, err := treeDigest(filepath.Join(old, name))
					if err != nil {
						t.Fatal(err)
					}
					state.Entries[name] = hash
					switch location {
					case "staged":
						writeMigrationCache(t, filepath.Join(current, migrationStage, "app"), name, "legacy cache")
						writeMigrationCache(t, current, name, "live cache")
					case "installed":
						writeMigrationCache(t, current, name, "cache changed after installation")
					}
				}
				state.SourceHash, _, err = treeDigest(old)
				if err != nil {
					t.Fatal(err)
				}
				// Also leave one real application entry pending activation.
				if err := os.Rename(filepath.Join(current, "proxy-settings.json"), filepath.Join(current, migrationStage, "app", "proxy-settings.json")); err != nil {
					t.Fatal(err)
				}
				file, _, _ := readMigration(current)
				state.Status, state.CompletedAt, state.LegacyCleanup = "verified", "", nil
				if err := saveMigration(current, file, state); err != nil {
					t.Fatal(err)
				}
				state, err = MigrateReaderData(old, current)
				if err != nil || state.Status != "completed" {
					t.Fatal(state, err)
				}
				assertMigrated(t, state.Library)
				if !pathExists(filepath.Join(current, "proxy-settings.json")) {
					t.Fatal("did not activate settings")
				}
				// Completed old journals and their cleanup hashes remain valid too.
				if _, err := MigrateReaderData(old, current); err != nil {
					t.Fatal(err)
				}
				if _, err := CleanupReaderData(old, current, "delete"); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}

func TestReaderMigrationDiagnosticReasons(t *testing.T) {
	for _, scenario := range []string{"migration_busy", "source_busy", "target_conflict", "entry_hash_mismatch", "stage_owner_mismatch", "invalid_record"} {
		t.Run(scenario, func(t *testing.T) {
			old, current, lib := legacyFixture(t, false)
			switch scenario {
			case "migration_busy":
				os.MkdirAll(current, 0700)
				lock := flock.New(filepath.Join(current, ".migration.lock"))
				ok, err := lock.TryLock()
				if err != nil || !ok {
					t.Fatal(ok, err)
				}
				defer lock.Unlock()
			case "source_busy":
				lock := flock.New(filepath.Join(lib, "reader.lock"))
				ok, err := lock.TryLock()
				if err != nil || !ok {
					t.Fatal(ok, err)
				}
				defer lock.Unlock()
			case "invalid_record":
				if err := os.MkdirAll(current, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(current, "migrations.json"), []byte("PRIVATE_RECORD_SENTINEL"), 0600); err != nil {
					t.Fatal(err)
				}
			case "target_conflict":
				state, err := MigrateReaderData(old, current)
				if err != nil {
					t.Fatal(err)
				}
				if err = os.Rename(filepath.Join(current, "proxy-settings.json"), filepath.Join(current, migrationStage, "app", "proxy-settings.json")); err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(filepath.Join(current, "proxy-settings.json"), []byte("PRIVATE_NEW_SETTINGS"), 0600); err != nil {
					t.Fatal(err)
				}
				file, _, _ := readMigration(current)
				state.Status = "verified"
				if err = saveMigration(current, file, state); err != nil {
					t.Fatal(err)
				}
			case "entry_hash_mismatch", "stage_owner_mismatch":
				state, err := MigrateReaderData(old, current)
				if err != nil {
					t.Fatal(err)
				}
				file, _, _ := readMigration(current)
				state.Status = "verified"
				if err := saveMigration(current, file, state); err != nil {
					t.Fatal(err)
				}
				path := filepath.Join(current, "proxy-settings.json")
				if scenario == "stage_owner_mismatch" {
					path = filepath.Join(current, migrationStage, "owner")
				}
				if err := os.WriteFile(path, []byte("PRIVATE_CONTENT_SENTINEL"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			var output bytes.Buffer
			previous := slog.Default()
			slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
			defer slog.SetDefault(previous)
			if _, err := MigrateReaderData(old, current); err == nil {
				t.Fatal("accepted conflict or modified data")
			}
			log := output.String()
			if !strings.Contains(log, `"reasonCode":"`+scenario+`"`) {
				t.Fatal(log)
			}
			if strings.Contains(log, "PRIVATE_") || strings.Contains(log, old) || strings.Contains(log, current) {
				t.Fatal("private migration data in logs")
			}
		})
	}
}

func TestReaderMigrationPreservesCacheNamedCustomLibrary(t *testing.T) {
	for _, collision := range []bool{false, true} {
		t.Run(fmt.Sprintf("collision=%v", collision), func(t *testing.T) {
			old, current, lib := legacyFixture(t, false)
			custom := filepath.Join(old, "GraphiteDawnCache")
			if err := os.Rename(lib, custom); err != nil {
				t.Fatal(err)
			}
			if err := atomicMigrationJSON(filepath.Join(old, "library-location.json"), map[string]string{"directory": custom}); err != nil {
				t.Fatal(err)
			}
			if collision {
				writeMigrationCache(t, current, "GraphiteDawnCache", "live cache")
			}
			state, err := MigrateReaderData(old, current)
			if collision {
				var classified *migrationError
				if !errors.As(err, &classified) || classified.reason != "target_conflict" {
					t.Fatal(err)
				}
				if !pathExists(filepath.Join(custom, "reader.sqlite")) {
					t.Fatal("lost source library")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			assertMigrated(t, state.Library)
		})
	}
}

func TestReaderMigrationRejectsUnknownDigestVersion(t *testing.T) {
	old, current, _ := legacyFixture(t, false)
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	file, _, _ := readMigration(current)
	state.DigestVersion = 99
	if err := saveMigration(current, file, state); err != nil {
		t.Fatal(err)
	}
	if _, err := MigrateReaderData(old, current); err == nil {
		t.Fatal("accepted unknown hash policy")
	}
}
