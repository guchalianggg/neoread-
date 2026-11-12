import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startLibraryRecoveryServer } from "./library-recovery-server";
it("serves recovery assets without exposing APIs or files outside the asset directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-recovery-"));
  const outside = await mkdtemp(join(tmpdir(), "reader-outside-"));
  await writeFile(join(root, "index.html"), "recovery UI");
  await writeFile(join(outside, "secret.js"), "secret");
  await symlink(join(outside, "secret.js"), join(root, "escape.js"));
  const server = await startLibraryRecoveryServer(root);
  try {
    expect(await (await fetch(server.url)).text()).toBe("recovery UI");
    expect((await fetch(server.url + "/api/settings")).status).toBe(404);
    expect((await fetch(server.url + "/escape.js")).status).toBe(404);
    expect((await fetch(server.url, { method: "POST" })).status).toBe(405);
  } finally {
    server.stop();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
