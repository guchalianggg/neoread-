import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({ dialog: {} }));
import { migrateReaderData } from "./legacy-data";

it.skipIf(process.platform === "win32")(
  "cancels the real migration child and waits until it exits",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "neoread-migration-child-"));
    const binary = join(root, "migration-probe");
    let pid: number | undefined;
    try {
      await writeFile(
        binary,
        `#!${process.execPath}\n` +
          `const fs = require("node:fs");\n` +
          `const path = require("node:path");\n` +
          `const root = process.argv[process.argv.indexOf("--data") + 1];\n` +
          `process.on("SIGTERM", () => setTimeout(() => {\n` +
          `  fs.writeFileSync(path.join(root, "exited"), "yes");\n` +
          `  process.exit(0);\n` +
          `}, 100));\n` +
          `fs.writeFileSync(path.join(root, "started"), String(process.pid));\n` +
          `setTimeout(() => process.exit(2), 1500);\n`,
        { mode: 0o700 },
      );
      const controller = new AbortController();
      const migration = migrateReaderData(
        binary,
        root,
        root,
        undefined,
        controller.signal,
      );
      // Attach rejection handling before aborting; the promise must settle only
      // after close, even though execFile reports AbortError immediately.
      const outcome = migration.catch((error: Error) => error);
      await vi.waitFor(async () => {
        pid = Number(await readFile(join(root, "started"), "utf8"));
        expect(pid).toBeGreaterThan(0);
      });
      controller.abort();
      expect(await outcome).toBeInstanceOf(Error);
      expect(await readFile(join(root, "exited"), "utf8")).toBe("yes");
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The expected path: the migration child has already been reaped.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
