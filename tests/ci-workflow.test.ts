import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("sets an external pnpm store before cache lookup without an invalid job context", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as {
    jobs: { verify: { env?: Record<string, string>; steps: { run?: string; uses?: string }[] } };
  };
  const job = workflow.jobs.verify;
  expect(job.env).toBeUndefined();
  const store = job.steps.findIndex((step) =>
    step.run?.includes("npm_config_store_dir=$RUNNER_TEMP/pnpm-store"),
  );
  const node = job.steps.findIndex((step) => step.uses === "actions/setup-node@v4");
  expect(store).toBeGreaterThanOrEqual(0);
  expect(store).toBeLessThan(node);
  expect(job.steps[store]?.run).toContain('>> "$GITHUB_ENV"');
  expect(job.steps[store]?.run).toContain("npm_config_package_import_method=copy");
  expect(
    job.steps.some((step) =>
      step.run?.includes('chmod 555 "$RUNNER_TEMP/conductor-node/bin/node"'),
    ),
  ).toBe(true);
});
