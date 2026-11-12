import { describe, expect, it } from "vitest";
import { migrateReaderPreferences } from "./legacy-preferences";
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}
describe("Reader preference migration", () => {
  it("converts known keys, preserves newer values and unrelated content", () => {
    const storage = memoryStorage();
    storage.setItem("reader.mark-color", "yellow");
    storage.setItem("neoread.mark-color", "blue");
    storage.setItem("reader.notes-export", '["notes"]');
    storage.setItem("reader.chat-session.doc", "session");
    storage.setItem("reader.unrelated", "original");
    migrateReaderPreferences(storage);
    expect(storage.getItem("neoread.mark-color")).toBe("blue");
    expect(storage.getItem("neoread.notes-export")).toBe('["notes"]');
    expect(storage.getItem("neoread.chat-session.doc")).toBe("session");
    expect(storage.getItem("reader.unrelated")).toBe("original");
    expect(storage.getItem("reader.notes-export")).toBeNull();
    storage.setItem("reader.chat-session.other", "old");
    migrateReaderPreferences(storage);
    expect(storage.getItem("neoread.chat-session.other")).toBeNull();
  });
  it("retains old values after a write failure and can retry", () => {
    const storage = memoryStorage();
    storage.setItem("reader.mark-color", "yellow");
    const write = storage.setItem;
    storage.setItem = () => {
      throw new Error("quota");
    };
    expect(() => migrateReaderPreferences(storage)).not.toThrow();
    expect(storage.getItem("reader.mark-color")).toBe("yellow");
    storage.setItem = write;
    migrateReaderPreferences(storage);
    expect(storage.getItem("neoread.mark-color")).toBe("yellow");
  });
});
