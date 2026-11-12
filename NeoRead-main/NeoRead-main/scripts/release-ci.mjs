import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// PR runs test a synthetic merge ref, not necessarily head_sha. Only direct
// branch/tag runs can attest that the exact release commit passed the full CI.
export function reusableCI(runs, sha, repository) {
  return runs.find(
    (run) =>
      run.head_sha === sha &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      ["push", "workflow_dispatch"].includes(run.event) &&
      run.path === ".github/workflows/ci.yml" &&
      run.head_repository?.full_name === repository,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { GH_REPO, SOURCE_SHA, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } =
    process.env;
  if (!GH_REPO || !SOURCE_SHA)
    throw new Error("GH_REPO and SOURCE_SHA are required");
  const pages = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        "--method",
        "GET",
        "--paginate",
        "--slurp",
        `repos/${GH_REPO}/actions/workflows/ci.yml/runs`,
        "-f",
        `head_sha=${SOURCE_SHA}`,
        "-f",
        "status=success",
        "-f",
        "per_page=100",
      ],
      { encoding: "utf8" },
    ),
  );
  const run = reusableCI(
    pages.flatMap((page) => page.workflow_runs),
    SOURCE_SHA,
    GH_REPO,
  );
  const verified = Boolean(run);
  const message = `Reuse successful CI for ${SOURCE_SHA}: ${verified}${run ? ` (run ${run.id}, ${run.event})` : "; full checks required"}`;
  console.log(message);
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `verified=${verified}\n`);
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${message}\n`);
}
