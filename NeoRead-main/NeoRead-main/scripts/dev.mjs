import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Start development with pnpm dev");
execFileSync(
  process.execPath,
  [pnpm, "--filter", "@neoread/processor", "build"],
  {
    stdio: "inherit",
  },
);
execFileSync(process.execPath, [pnpm, "--filter", "@neoread/agent", "build"], {
  stdio: "inherit",
});
const token = randomBytes(32).toString("hex");
execFileSync(
  process.execPath,
  [fileURLToPath(new URL("./build-server.mjs", import.meta.url))],
  { stdio: "inherit" },
);
const binary =
  process.platform === "win32" ? "neoread-server.exe" : "neoread-server";
const server = spawn(
  `../desktop/bin/${binary}`,
  [
    "--data",
    "../../.neoread",
    "--port",
    "17840",
    ...(process.env.NEOREAD_DEV_CONNECTOR === "1" ? [] : ["--connector=false"]),
  ],
  {
    cwd: new URL("../apps/server/", import.meta.url),
    env: {
      ...process.env,
      NEOREAD_TOKEN: token,
      NEOREAD_NODE: process.execPath,
      NEOREAD_AGENT: fileURLToPath(
        new URL("../apps/agent/dist/main.mjs", import.meta.url),
      ),
      NEOREAD_PROCESSOR: fileURLToPath(
        new URL("../apps/processor/dist/main.mjs", import.meta.url),
      ),
    },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
let web;
createInterface({ input: server.stdout }).once("line", () => {
  web = spawn(process.execPath, [pnpm, "--filter", "@neoread/web", "dev"], {
    stdio: "inherit",
  });
  console.log(`\nNeoRead: http://127.0.0.1:5173/#token=${token}\n`);
  web.once("exit", () => stop());
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.kill("SIGINT");
  web?.kill("SIGTERM");
}
server.once("exit", () => stop());
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stop();
  });
