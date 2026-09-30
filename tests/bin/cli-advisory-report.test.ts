import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/bin/cli-main.js";

describe("conduct advisory-report CLI", () => {
  it("dispatches JSON reporting over a runs directory without starting a run", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "advisory-report-"));
    const lines: string[] = [];
    const errors: string[] = [];
    try {
      const exitCode = await runCli(["advisory-report", runsDir, "--json"], {
        startRun: async () => {
          throw new Error("advisory-report must not start an orchestration run");
        },
        modelRegistry: {} as ModelRegistry,
        console: {
          ...console,
          log: (message?: unknown) => {
            if (typeof message === "string") lines.push(message);
          },
          error: (message?: unknown) => {
            if (typeof message === "string") errors.push(message);
          },
        },
        exit: () => {},
        cwd: process.cwd(),
      });

      expect(exitCode).toBe(0);
      expect(errors).toEqual([]);
      expect(JSON.parse(lines.join("\n"))).toMatchObject({
        schema_version: 1,
        coverage: { admitted_tasks: 0 },
      });
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });
});
