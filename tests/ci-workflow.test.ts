import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("keeps the runner's pnpm cache outside checked repository inputs", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as { jobs: { verify: { env?: Record<string, string>; runs_on?: string } } };
  expect(workflow.jobs.verify.env?.npm_config_store_dir).toBe("${{ runner.temp }}/pnpm-store");
});
