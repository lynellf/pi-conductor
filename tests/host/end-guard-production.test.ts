import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRun } from "../../src/host/api.js";
import { ProductionHost } from "../../src/host/production-host.js";
import type { RecordLog } from "../../src/persistence/log.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const roots: string[] = [];
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProductionHost end guard abort ownership", () => {
  it("aborts a real active guard before RunHandle completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-conductor-end-guard-production-"));
    roots.push(root);
    await writeFile(join(root, "role.md"), "Finish the run.", "utf8");
    const marker = join(root, "guard-started");
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, 10000)`)}`;
    const manifest = join(root, "manifest.yaml");
    await writeFile(
      manifest,
      `version: 1
end_guard:
  command: ${JSON.stringify(command)}
  timeout_seconds: 60
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:stub-model, effort: off }]
    system_prompt: role.md
    tools: [handoff, end]
`,
      "utf8",
    );
    let log: RecordLog | undefined;
    const modelRegistry = makeModelRegistryWithStub([{ kind: "emit_end", reason: "finished" }]);
    let handle: Awaited<ReturnType<typeof startRun>> | undefined;
    try {
      handle = await startRun(manifest, {
        goal: "finish",
        baseDir: join(root, "runs"),
        modelRegistry,
        hostFactory: ({ runId, loadedManifest, log: recordLog }) => {
          log = recordLog;
          return new ProductionHost({
            runId,
            log: recordLog,
            loadedManifest,
            modelRegistry,
            cwd: root,
            agentDir: makeAndTrackIsolatedAgentDir("pi-conductor-end-guard-production-"),
          });
        },
      });
      const deadline = Date.now() + 10_000;
      let pid = 0;
      while (Date.now() < deadline) {
        try {
          const markerContent = await readFile(marker, "utf8");
          const candidate = Number(markerContent.trim());
          if (Number.isInteger(candidate) && candidate > 0) {
            pid = candidate;
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const markerContent = await readFile(marker, "utf8");
      expect(pid).toBeGreaterThan(0);
      await handle.abort("operator abort");
      const completion = await handle.completion();
      expect(completion.exitReason).toBe("aborted");
      const records = log?.records(handle.runId) ?? [];
      const started = records.filter((record) => record.type === "end_guard_started");
      const finished = records.filter((record) => record.type === "end_guard_finished");
      expect(started).toHaveLength(1);
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ outcome: "aborted", cleanup: "confirmed" });
      expect(records.some((record) => record.type === "transition_accepted")).toBe(false);
      await expect(readFile(marker, "utf8")).resolves.toBe(markerContent);
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        expect(stat.split(" ")[2]).toBe("Z");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ESRCH") throw error;
      }
    } finally {
      if (handle !== undefined) {
        await handle.abort("test cleanup").catch(() => undefined);
        await handle.completion().catch(() => undefined);
      }
    }
  }, 20_000);
});
