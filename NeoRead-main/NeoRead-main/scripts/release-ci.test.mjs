import { expect, test } from "vitest";
import { reusableCI } from "./release-ci.mjs";

const sha = "abc123";
const repository = "owner/NeoRead";
const success = {
  id: 12,
  head_sha: sha,
  status: "completed",
  conclusion: "success",
  event: "workflow_dispatch",
  path: ".github/workflows/ci.yml",
  head_repository: { full_name: repository },
};

test.each(["workflow_dispatch", "push"])(
  "reuses successful exact-commit %s CI",
  (event) => {
    const run = { ...success, event };
    expect(reusableCI([run], sha, repository)).toBe(run);
  },
);

test.each([
  { head_sha: "different" },
  { status: "in_progress" },
  { conclusion: "failure" },
  { conclusion: "cancelled" },
  { event: "pull_request" },
  { event: "pull_request_target" },
  { path: ".github/workflows/build.yml" },
  { head_repository: { full_name: "fork/NeoRead" } },
  { head_repository: null },
])("does not reuse unverified source or incomplete checks: %j", (override) => {
  expect(
    reusableCI([{ ...success, ...override }], sha, repository),
  ).toBeUndefined();
});

test("a rejected candidate does not hide a later valid run", () => {
  expect(
    reusableCI(
      [{ ...success, event: "pull_request" }, success],
      sha,
      repository,
    ),
  ).toBe(success);
  expect(reusableCI([], sha, repository)).toBeUndefined();
});
