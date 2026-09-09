import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { runLoop } from "../../src/host/loop.js";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import {
  createInitialCheckpoint,
  InMemoryRecordLog,
  loadManifestFromString,
  ProductionHost,
} from "../../src/index.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

const YAML = `version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    context_retention: run
    models: [{ model: stub:compact, effort: off }]
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
  - name: worker
    max_visits: 2
    models: [{ model: stub:compact, effort: off }]
    system_prompt: .pi/roles/worker.md
    tools: [handoff, end]
`;

describe("ProductionHost retained context compaction", () => {
  it("records a real compaction after two prior orchestrator turns", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-production-compaction-"));
    try {
      await mkdir(join(cwd, ".pi", "roles"), { recursive: true });
      await writeFile(join(cwd, ".pi/roles/orchestrator.md"), "orchestrator", "utf8");
      await writeFile(join(cwd, ".pi/roles/worker.md"), "worker", "utf8");
      await writeFile(
        join(cwd, ".pi/settings.json"),
        '{"compaction":{"enabled":true,"reserveTokens":4000,"keepRecentTokens":100}}',
        "utf8",
      );
      const base = { ...makeStubModel(), contextWindow: 20_000 };
      const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
      registry.registerProvider("stub", {
        api: base.api,
        apiKey: "stub-key",
        baseUrl: base.baseUrl,
        streamSimple: (
          (ordinary, summary) => (model, context, options) =>
            context.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT
              ? summary(model, context, options)
              : ordinary(model, context, options)
        )(
          makeStubStreamFunction({
            steps: [
              {
                kind: "emit_handoff",
                target_role: "worker",
                reason: "a".repeat(1000),
                usage: {
                  input: 18_000,
                  output: 10,
                  totalTokens: 18_010,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.018 },
                },
              },
              { kind: "emit_handoff", target_role: "orchestrator", reason: "b".repeat(1000) },
              { kind: "emit_handoff", target_role: "worker", reason: "c".repeat(1000) },
              { kind: "emit_handoff", target_role: "orchestrator", reason: "d".repeat(1000) },
              { kind: "emit_end", reason: "complete" },
            ],
          }),
          makeStubStreamFunction({
            steps: [
              {
                kind: "emit_text",
                text: "summary",
                usage: {
                  input: 17,
                  output: 5,
                  totalTokens: 22,
                  cost: { input: 0.017, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.022 },
                },
              },
            ],
          }),
        ),
        models: [{ ...base, id: "compact" }],
      });
      const loaded = loadManifestFromString(YAML, cwd);
      const log = new InMemoryRecordLog();
      const checkpoint = createInitialCheckpoint(loaded.def);
      const host = new ProductionHost({
        runId: checkpoint.run_id,
        log,
        loadedManifest: loaded,
        cwd,
        agentDir: makeAndTrackIsolatedAgentDir(),
        modelRegistry: registry,
      });
      const result = await runLoop({
        def: loaded.def,
        initialCheckpoint: checkpoint,
        host,
        initialGoal: "seed",
      });
      expect(result.exitReason).toBe("done");
      const records = log.records(checkpoint.run_id);
      expect(records.filter((record) => record.type === "context_compaction_started")).toHaveLength(
        1,
      );
      const compaction = records.find((record) => record.type === "context_compaction");
      expect(compaction).toMatchObject({
        outcome: "completed",
        usage: { cost: 0.022, tokens: 22 },
      });
      const terminalCost = records
        .filter((record) => record.type === "session_ended" || record.type === "session_failed")
        .reduce((total, record) => {
          if (record.usage === undefined) throw new Error("terminal record missing usage");
          return total + record.usage.cost;
        }, 0);
      expect(terminalCost).toBeCloseTo(0.04, 10);
      expect(host.runCostSoFar()).toBeCloseTo(0.04, 10);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
