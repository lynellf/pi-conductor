import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  createInitialCheckpoint,
  FileRecordLog,
  InMemoryRecordLog,
  loadManifest,
  loadManifestFromString,
  ProductionHost,
  resumeRun,
  type SessionLifecycleEvent,
} from "../../src/index.js";
import { createManifestSnapshot } from "../../src/persistence/trajectory-records.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";

const MANIFEST = `
version: 1
handoffs:
  - from: orchestrator
    to: implementer
    mode: trajectory
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:stub-model, effort: off }]
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
  - name: implementer
    max_visits: 1
    models: [{ model: stub:stub-model, effort: off }]
    system_prompt: .pi/roles/implementer.md
    tools: [handoff, end]
`;

describe("Issue #63 trajectory resume", () => {
  it("reopens the selected physical conversation rather than creating a fresh target", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-trajectory-resume-"));
    try {
      const baseDir = join(workdir, "runs");
      const manifestPath = join(workdir, ".pi", "conductor.yaml");
      await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
      await writeFile(manifestPath, MANIFEST, "utf8");
      await writeFile(join(workdir, ".pi", "roles", "orchestrator.md"), "ORCHESTRATOR", "utf8");
      await writeFile(join(workdir, ".pi", "roles", "implementer.md"), "IMPLEMENTER", "utf8");
      const loaded = await loadManifest(manifestPath);
      const checkpoint = createInitialCheckpoint(loaded.def);
      const resumedCheckpoint = {
        ...checkpoint,
        current_role: "implementer",
        visit_count: { implementer: 1 },
        updated_at: 1,
      };
      const log = new FileRecordLog({ baseDir });
      log.append(
        createManifestSnapshot({
          runId: checkpoint.run_id,
          manifest: loaded.manifest,
          definition: loaded.def,
          ts: 1,
        }),
      );
      log.append({ type: "checkpoint_snapshot", checkpoint: resumedCheckpoint });
      log.append({ type: "run_seeded", run_id: checkpoint.run_id, goal: "resume", ts: 1 });

      const registry = makeModelRegistryWithStub();
      const sourceHost = new ProductionHost({
        modelRegistry: registry,
        cwd: workdir,
        log,
        loadedManifest: loaded,
        runId: checkpoint.run_id,
      });
      const source = await sourceHost.spawnRole("orchestrator");
      const sourceConversation = {
        id: source.conversationId ?? source.sessionId,
        file: source.sessionFile,
      };
      await source.dispose();
      log.append({
        type: "handoff_transport_selected",
        schema_version: 1,
        run_id: checkpoint.run_id,
        source_role_session_id: source.sessionId,
        from: "orchestrator",
        to: "implementer",
        mode: "trajectory",
        source_conversation: sourceConversation,
        target: {
          model: "stub:stub-model",
          requested_effort: "off",
          system_prompt: "IMPLEMENTER",
          active_tool_names: ["handoff", "end", "ask_user"],
          environment_sha256: "test",
        },
        admission: {
          schema_version: 1,
          observed_context_tokens: 0,
          role_envelope_tokens: 0,
          target_max_tokens: 8192,
          safety_reservation_tokens: 8192,
          required_tokens: 16384,
          target_context_window: 200000,
          target_model: "stub:stub-model",
        },
        ts: 2,
      });

      // Snapshot-era resume must not parse a changed (or malformed) current YAML.
      await writeFile(manifestPath, "this: [is not valid", "utf8");
      const handle = await resumeRun(manifestPath, checkpoint.run_id, {
        goal: "ignored",
        baseDir,
        hostFactory: ({ runId, log: resumedLog, loadedManifest }) =>
          new ProductionHost({
            modelRegistry: makeModelRegistryWithStub([
              { kind: "emit_handoff", target_role: "orchestrator" },
              { kind: "emit_end" },
            ]),
            cwd: workdir,
            log: resumedLog,
            loadedManifest,
            runId,
          }),
      });
      await expect(handle.completion()).resolves.toMatchObject({ exitReason: "done" });
      const starts = log
        .records(checkpoint.run_id)
        .filter(
          (record): record is SessionLifecycleEvent =>
            record.type === "session_started" && record.role === "implementer",
        );
      expect(starts).toHaveLength(1);
      expect(starts[0]?.session_file).toBe(sourceConversation.file);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("surfaces a durable trajectory failure without reopening or retrying its target", async () => {
    const loaded = loadManifestFromString(MANIFEST);
    const log = new InMemoryRecordLog();
    log.append({
      type: "trajectory_handoff_failed",
      schema_version: 1,
      run_id: "failed-trajectory",
      from: "orchestrator",
      to: "implementer",
      source_conversation: { id: "shared-conversation", file: "/unused.jsonl" },
      code: "trajectory_context_too_large",
      message: "admission failed before target start",
      ts: 1,
    });
    const host = new ProductionHost({
      modelRegistry: makeModelRegistryWithStub(),
      cwd: process.cwd(),
      log,
      loadedManifest: loaded,
      runId: "failed-trajectory",
    });

    await expect(host.spawnRole("implementer")).rejects.toThrow("previously failed");
    expect(log.records("failed-trajectory")).toHaveLength(1);
  });
});
