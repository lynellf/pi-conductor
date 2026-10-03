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
  expect(job.steps.some((step) => step.run?.includes("chmod go-w"))).toBe(true);
  const runtime = job.steps.find((step) =>
    step.run?.includes('chmod 555 "$RUNNER_TEMP/conductor-node/bin/node"'),
  )?.run;
  expect(runtime).toContain('source_node="$(command -v node)"');
  expect(runtime).toContain(
    'cp -R "$(dirname "$source_node")/../include/node" "$RUNNER_TEMP/conductor-node/include/node"',
  );
  expect(runtime).toContain('chmod 700 "$RUNNER_TEMP/conductor-node/include"');
  expect(
    job.steps.some(
      (step) => step.run?.includes("setpriv --reuid=65534") && step.run.includes("pnpm test"),
    ),
  ).toBe(true);
});
