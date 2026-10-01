import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runSupervisedProcess } from "../../src/host/execution/supervised-process.js";

it.runIf(process.platform === "darwin")(
  "holds Node preload effects until admission and preserves workload flags",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-macos-preload-"));
    try {
      const marker = join(cwd, "effect");
      const preload = join(cwd, "preload.cjs");
      await writeFile(
        preload,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'released')`,
      );
      const result = await runSupervisedProcess({
        executionId: randomUUID(),
        cwd,
        file: process.execPath,
        args: ["-e", "process.stdout.write('workload')"],
        env: { NODE_OPTIONS: `--require=${preload}` },
        timeoutMs: 3_000,
        onStart: () => undefined,
        onSpawn: async () => {
          await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
        },
      });
      expect(result.stdout).toBe("workload");
      expect(await readFile(marker, "utf8")).toBe("released");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
