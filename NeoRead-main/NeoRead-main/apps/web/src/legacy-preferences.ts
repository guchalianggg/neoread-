const migrationKey = "neoread.migrations.reader-preferences-v1";

/** Convert only known UI preferences, once per browser origin. */
export function migrateReaderPreferences(storage?: Storage): void {
  try {
    const local = storage ?? globalThis.localStorage;
    if (local.getItem(migrationKey)) return;
    const keys = Array.from({ length: local.length }, (_, i) => local.key(i));
    for (const key of keys) {
      if (
        key !== "reader.mark-color" &&
        key !== "reader.notes-export" &&
        !key?.startsWith("reader.chat-session.")
      )
        continue;
      const target = `neoread${key.slice("reader".length)}`;
      const value = local.getItem(key);
      if (value !== null && local.getItem(target) === null)
        local.setItem(target, value);
      local.removeItem(key);
    }
    local.setItem(migrationKey, "completed");
  } catch {
    // Storage may be unavailable or full. Keep remaining old keys for a retry.
  }
}
