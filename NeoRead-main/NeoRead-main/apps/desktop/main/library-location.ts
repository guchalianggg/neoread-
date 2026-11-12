import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  rename,
  rm,
  stat,
  access,
  realpath,
} from "node:fs/promises";
import { isAbsolute, join, dirname, basename, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
const execute = promisify(execFile);

export async function libraryDirectory(userData: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(join(userData, "library-location.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return join(userData, "library");
    throw error;
  }
  let directory: unknown;
  try {
    directory = JSON.parse(text)?.directory;
  } catch {}
  if (typeof directory !== "string" || !isAbsolute(directory))
    throw new Error("保存的书库位置无效，请检查 library-location.json。");
  try {
    await access(directory, constants.R_OK | constants.W_OK);
    const database = await existingDatabase(directory);
    await access(database, constants.R_OK | constants.W_OK);
    if (!(await stat(database)).isFile()) throw new Error();
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code || "INVALID_DATABASE";
    throw new Error(`无法访问已设置的书库（${code}）：${directory}`, { cause });
  }
  return directory;
}

/** Stdin EOF works on Windows too, unlike SIGTERM's forced termination there. */
export function stopLibraryServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error("本地服务未正常停止"));
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.removeListener("close", closed);
      child.removeListener("error", failed);
      child.stdin?.removeListener("error", failed);
      if (error) reject(error);
      else resolve();
    };
    const closed = (code: number | null) =>
      finish(code === 0 ? undefined : new Error("本地服务未正常停止"));
    const failed = (error: Error) => finish(error);
    const timer = setTimeout(
      () => finish(new Error("本地服务停止超时，未迁移书库")),
      30_000,
    );
    child.once("close", closed);
    child.once("error", failed);
    child.stdin?.once("error", failed);
    if (!child.stdin) finish(new Error("无法停止本地服务"));
    else child.stdin.end();
  });
}

export async function migrateLibrary(
  userData: string,
  source: string,
  destination: string,
  binary: string,
  stop: () => Promise<void>,
  programDir?: string,
): Promise<void> {
  await validateLibraryDestination(destination, programDir);
  await stop();
  try {
    await execute(
      binary,
      ["--data", source, "--migrate-library", destination],
      {
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
    );
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
  await saveLibraryDirectory(userData, destination, programDir);
}

export async function saveLibraryDirectory(
  userData: string,
  destination: string,
  programDir?: string,
) {
  await validateLibraryDestination(destination, programDir);
  const temporary = join(userData, `library-location.${randomUUID()}.tmp`);
  try {
    await writeFile(
      temporary,
      JSON.stringify({ directory: destination }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporary, join(userData, "library-location.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Only new selections are rejected. Existing saved locations still open for migration. */
export async function validateLibraryDestination(
  directory: string,
  programDir?: string,
) {
  if (!isAbsolute(directory) || directory.includes("?"))
    throw new Error("请选择有效的绝对路径，书库路径不能包含 ?。");
  // The caller supplies the actual packaged executable directory. Dev mode omits it.
  if (!programDir) return;
  const inside = (child: string, parent: string) => {
    if (process.platform === "win32") {
      child = child.toLowerCase();
      parent = parent.toLowerCase();
    }
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  async function canonicalFuturePath(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      return join(await canonicalFuturePath(parent), basename(path));
    }
  }
  if (
    inside(directory, programDir) || inside(programDir, directory) ||
    inside(await canonicalFuturePath(directory), await realpath(programDir)) ||
    inside(await realpath(programDir), await canonicalFuturePath(directory))
  )
    throw new Error("书库不能位于 NeoRead 程序安装目录内，也不能包含程序目录。请选择独立的外部目录；原书库位置保持不变。");
}

export async function validateLibraryDirectory(
  directory: string,
  binary: string,
  programDir?: string,
) {
  await validateLibraryDestination(directory, programDir);
  await access(directory, constants.R_OK | constants.W_OK);
  await access(
    await existingDatabase(directory),
    constants.R_OK | constants.W_OK,
  );
  try {
    await execute(binary, ["--data", directory, "--check-library"], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}

async function existingDatabase(directory: string) {
  const current = join(directory, "neoread.sqlite");
  try {
    await stat(current);
    return current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return join(directory, "reader.sqlite");
}
