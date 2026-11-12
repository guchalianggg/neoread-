package neoread

import (
	"bytes"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// This must include normal service initialization between migration and cleanup.
// Calling the two migration functions back-to-back misses citation's writes.
func cleanupWithCitation(t *testing.T, previousFiles bool, legacy ...bool) (string, string, *Server) {
	t.Helper()
	old, current, _ := legacyFixture(t, false)
	if previousFiles {
		for name, value := range map[string]string{"cite-credential": strings.Repeat("1", 64), "cite-wps-key": strings.Repeat("2", 64)} {
			if err := os.WriteFile(filepath.Join(old, name), []byte(value), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	state, err := MigrateReaderData(old, current)
	if err != nil {
		t.Fatal(err)
	}
	if len(legacy) > 0 && legacy[0] {
		state.DataOnly = false
		state.SourceHash, _, err = state.treeDigest(old)
		if err != nil {
			t.Fatal(err)
		}
		for _, name := range readerCitationNames {
			if !pathExists(filepath.Join(old, name)) {
				continue
			}
			data, err := os.ReadFile(filepath.Join(old, name))
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(current, name), data, 0600); err != nil {
				t.Fatal(err)
			}
			state.Entries[name], err = digestEntry(filepath.Join(current, name))
			if err != nil {
				t.Fatal(err)
			}
		}
		file, _, err := readMigration(current)
		if err != nil {
			t.Fatal(err)
		}
		if err = saveMigration(current, file, state); err != nil {
			t.Fatal(err)
		}
	}
	store, err := OpenLibrary(state.Library)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.DB.Close() })
	server := NewServer(store, "fixture-auth", "")
	t.Cleanup(server.Close)
	if err := server.SetCiteCredential(filepath.Join(old, "cite-credential")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(old, "cite-wps-key"), []byte(strings.Repeat("3", 64)), 0600); err != nil {
		t.Fatal(err)
	}
	return old, current, server
}

func TestReaderCleanupPreservesLiveCitationFiles(t *testing.T) {
	for _, scenario := range []string{"new_files", "rotated_files", "unversioned_record", "legacy_rotated"} {
		t.Run(scenario, func(t *testing.T) {
			old, current, server := cleanupWithCitation(t, scenario != "new_files", scenario == "unversioned_record" || scenario == "legacy_rotated")
			if scenario == "unversioned_record" {
				file, state, err := readMigration(current)
				if err != nil {
					t.Fatal(err)
				}
				state.DigestVersion = 0
				if err := saveMigration(current, file, state); err != nil {
					t.Fatal(err)
				}
			}
			_, before, err := readMigration(current)
			if err != nil {
				t.Fatal(err)
			}
			credential, err := os.ReadFile(filepath.Join(old, "cite-credential"))
			if err != nil {
				t.Fatal(err)
			}
			state, err := CleanupReaderData(old, current, "delete")
			if err != nil {
				t.Fatal(err)
			}
			if state.SourceHash != before.SourceHash || state.DigestVersion != before.DigestVersion {
				t.Fatal("rewrote the historical source fingerprint")
			}
			if state.LegacyCleanup.Status != "deleted" {
				t.Fatal(state.LegacyCleanup.Status)
			}
			if pathExists(filepath.Join(old, "library", "reader.sqlite")) || pathExists(filepath.Join(old, "proxy-settings.json")) {
				t.Fatal("did not remove migrated reading data")
			}
			assertMigrated(t, state.Library)
			preserved, err := os.ReadFile(filepath.Join(old, "cite-credential"))
			if err != nil || string(preserved) != string(credential) {
				t.Fatal("Word credential lost or changed")
			}
			request := httptest.NewRequest("POST", "http://127.0.0.1:17841/v1/cite/bootstrap", nil)
			request.Header.Set("Authorization", "Bearer "+strings.Repeat("3", 64))
			response := httptest.NewRecorder()
			server.citeBootstrap(response, request)
			if response.Code != 200 {
				t.Fatalf("WPS bootstrap broke after cleanup: %d", response.Code)
			}
			if _, err := MigrateReaderData(old, current); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestReaderCleanupStillRejectsOtherChanges(t *testing.T) {
	for _, scenario := range []string{"document_change", "unexpected_file", "invalid_credential", "credential_symlink", "tampered_snapshot"} {
		t.Run(scenario, func(t *testing.T) {
			old, current, _ := cleanupWithCitation(t, scenario == "tampered_snapshot", scenario == "invalid_credential" || scenario == "credential_symlink" || scenario == "tampered_snapshot")
			var err error
			switch scenario {
			case "document_change":
				err = os.WriteFile(filepath.Join(old, "library", "papers", "paper.pdf"), []byte("PRIVATE_CHANGED_DOCUMENT"), 0600)
			case "unexpected_file":
				err = os.WriteFile(filepath.Join(old, "library", "PRIVATE_NEW_NOTE"), []byte("new note"), 0600)
			case "invalid_credential":
				err = os.WriteFile(filepath.Join(old, "cite-credential"), []byte("PRIVATE_NON_CREDENTIAL"), 0600)
			case "credential_symlink":
				if os.PathSeparator != '/' {
					t.Skip("symlink privilege depends on Windows host")
				}
				if err = os.Remove(filepath.Join(old, "cite-credential")); err == nil {
					err = os.Symlink(filepath.Join(old, "cite-wps-key"), filepath.Join(old, "cite-credential"))
				}
			case "tampered_snapshot":
				err = os.WriteFile(filepath.Join(current, "cite-credential"), []byte(strings.Repeat("4", 64)), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := CleanupReaderData(old, current, "delete"); err == nil {
				t.Fatal("deleted changed or unverifiable reading data")
			}
			if _, err := RetryReaderCleanup(old, current); err == nil {
				t.Fatal("retry bypassed source verification")
			}
			if !pathExists(filepath.Join(old, "library", "reader.sqlite")) {
				t.Fatal("lost original library")
			}
			assertMigrated(t, filepath.Join(current, "library"))
		})
	}
}

func TestReaderCleanupDiagnosticPrivacy(t *testing.T) {
	old, current, _ := cleanupWithCitation(t, false)
	if err := os.WriteFile(filepath.Join(old, "library", "PRIVATE_NEW_NOTE"), []byte("PRIVATE_DOCUMENT_SENTINEL"), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	defer slog.SetDefault(previous)
	if _, err := CleanupReaderData(old, current, "delete"); err == nil {
		t.Fatal("accepted changed source")
	}
	log := output.String()
	if !strings.Contains(log, `"msg":"migration.cleanup_failed","phase":"verify_source","reasonCode":"source_changed"`) {
		t.Fatal("missing controlled cleanup failure reason")
	}
	if strings.Contains(log, "PRIVATE_") || strings.Contains(log, old) || strings.Contains(log, strings.Repeat("3", 64)) {
		t.Fatal("private content in cleanup diagnostics")
	}
}

func TestReaderCleanupRuntimeSnapshotAndHashFormat(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "a"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{filepath.Join("a", "one"): "a", "z": "z", "reader.lock": "excluded"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	hash, _, err := treeDigest(root)
	if err != nil {
		t.Fatal(err)
	}
	expected := "f9211490286efa52cfe5fd49b37cc9e9bbdfd0d4771fd99e56a2c2e62af80714"
	if os.PathSeparator == '\\' {
		expected = "a330b681af36ae8dfd3bf91718066ee10392a19cd16982577d38549a94ccc3ab"
	}
	if hash != expected {
		t.Fatal("changed historical source hash format")
	}
}

func TestReaderCleanupKeepsDataWhenQuarantineExists(t *testing.T) {
	old, current, _ := cleanupWithCitation(t, false)
	_, state, err := readMigration(current)
	if err != nil {
		t.Fatal(err)
	}
	quarantine := filepath.Join(filepath.Dir(old), ".reader-cleanup-"+state.ID)
	if err := os.Mkdir(quarantine, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := CleanupReaderData(old, current, "delete"); err == nil {
		t.Fatal("overwrote existing cleanup directory")
	}
	if !pathExists(filepath.Join(old, "library", "reader.sqlite")) {
		t.Fatal("lost old library")
	}
	if !pathExists(filepath.Join(old, "cite-credential")) {
		t.Fatal("lost live Word credential")
	}
}

func TestReaderCleanupRetryIsExplicit(t *testing.T) {
	for _, status := range []string{"failed", "kept"} {
		t.Run(status, func(t *testing.T) {
			old, current, _ := cleanupWithCitation(t, false)
			file, state, err := readMigration(current)
			if err != nil {
				t.Fatal(err)
			}
			state.LegacyCleanup.Status = status
			if err := saveMigration(current, file, state); err != nil {
				t.Fatal(err)
			}
			if _, err := CleanupReaderData(old, current, "delete"); err != nil {
				t.Fatal(err)
			}
			if !pathExists(filepath.Join(old, "library", "reader.sqlite")) {
				t.Fatal("automatically retried cleanup")
			}
			result, err := RetryReaderCleanup(old, current)
			if status == "kept" {
				if err == nil || !pathExists(filepath.Join(old, "library", "reader.sqlite")) {
					t.Fatal("overrode decision to keep data")
				}
			} else {
				if err != nil || result.LegacyCleanup.Status != "deleted" {
					t.Fatal("explicit retry failed", err)
				}
				if pathExists(filepath.Join(old, "library", "reader.sqlite")) || !pathExists(filepath.Join(old, "cite-credential")) {
					t.Fatal("retry removed the wrong data")
				}
			}
		})
	}
}

func TestReaderCleanupRetryDoesNotReplaceInitialChoice(t *testing.T) {
	old, current, _ := cleanupWithCitation(t, false)
	if _, err := RetryReaderCleanup(old, current); err == nil {
		t.Fatal("used retry before initial cleanup decision")
	}
	if !pathExists(filepath.Join(old, "library", "reader.sqlite")) {
		t.Fatal("deleted data before initial decision")
	}
	_, state, err := readMigration(current)
	if err != nil || state.LegacyCleanup.Status != "pending" {
		t.Fatal("changed initial cleanup decision")
	}
}
