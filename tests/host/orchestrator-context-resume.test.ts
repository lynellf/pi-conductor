import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createInitialCheckpoint } from "../../src/core/reduce.js";
import { resumeRun } from "../../src/host/api.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import { captureOrchestratorContextBoundary } from "../../src/host/orchestrator-context-files.js";
import {
  admitOrchestratorContextResume,
  resetOrchestratorContext,
} from "../../src/host/orchestrator-context-resume.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { createManifestSnapshot } from "../../src/persistence/trajectory-records.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const manifest = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    context_retention: run
    models: [{ model: stub:orchestrator, effort: medium }]
    system_prompt: orchestrator.md
  - name: worker
    max_visits: 1
    models: [{ model: stub:worker, effort: medium }]
    system_prompt: worker.md
`;

describe("orchestrator context resume admission", () => {
  it("disables unsnapshotted current retention and reports compatibility", async () => {
    const loaded = loadManifestFromString(manifest);
    const log = new InMemoryRecordLog();
    const effective = await admitOrchestratorContextResume({
      runId: "run-1",
      records: [],
      log,
      loadedManifest: loaded,
      reset: false,
    });
    expect(
      effective.manifest.roles.find((role) => role.name === "orchestrator")?.context_retention,
    ).toBe("none");
    expect(
      effective.warnings.some((warning) => warning.code === "legacy-context-retention-unproven"),
    ).toBe(true);
  });

  it("preserves pinned settings while appending a reset epoch", async () => {
    const loaded = loadManifestFromString(manifest);
    const log = new InMemoryRecordLog();
    const snapshot = createManifestSnapshot({
      runId: "run-1",
      manifest: loaded.manifest,
      definition: loaded.def,
      ts: 1,
    });
    const epoch = {
      schema_version: 1 as const,
      type: "context_epoch_started" as const,
      run_id: "run-1",
      role: "orchestrator",
      epoch: 1,
      reason: "start" as const,
      previous_epoch: null,
      compaction: { enabled: true, reserve_tokens: 100, keep_recent_tokens: 200 },
      ts: 2,
    };
    log.append(snapshot);
    log.append(epoch);
    const records = log.records("run-1");
    await admitOrchestratorContextResume({
      runId: "run-1",
      records,
      log,
      loadedManifest: loaded,
      reset: true,
    });
    resetOrchestratorContext({ runId: "run-1", records, log, loadedManifest: loaded });
    expect(log.records("run-1").at(-1)).toMatchObject({
      type: "context_epoch_started",
      epoch: 2,
      compaction: epoch.compaction,
    });
  });

  it("allows reset to clear a pending invocation but blocks unknown compaction cost", async () => {
    const loaded = loadManifestFromString(manifest);
    const log = new InMemoryRecordLog();
    const snapshot = createManifestSnapshot({
      runId: "run-1",
      manifest: loaded.manifest,
      definition: loaded.def,
      ts: 1,
    });
    const epoch = {
      schema_version: 1 as const,
      type: "context_epoch_started" as const,
      run_id: "run-1",
      role: "orchestrator",
      epoch: 1,
      reason: "start" as const,
      previous_epoch: null,
      compaction: { enabled: true, reserve_tokens: 100, keep_recent_tokens: 200 },
      ts: 2,
    };
    const invocation = {
      schema_version: 1 as const,
      type: "context_invocation_started" as const,
      run_id: "run-1",
      role: "orchestrator",
      epoch: 1,
      role_session_id: "session-1",
      conversation_id: "conversation-1",
      session_file: "/tmp/session-1.jsonl",
      model: "stub:model",
      source_boundary: null,
      ts: 3,
    };
    const pendingRecords = [snapshot, epoch, invocation] as const;
    expect(
      await admitOrchestratorContextResume({
        runId: "run-1",
        records: pendingRecords,
        log,
        loadedManifest: loaded,
        reset: true,
      }),
    ).toBe(loaded);
    const started = {
      schema_version: 1 as const,
      type: "context_compaction_started" as const,
      run_id: "run-1",
      role: "orchestrator",
      epoch: 1,
      role_session_id: "session-1",
      request_id: "request-1",
      before_leaf_id: null,
      ts: 4,
    };
    await expect(
      admitOrchestratorContextResume({
        runId: "run-1",
        records: [...pendingRecords, started],
        log,
        loadedManifest: loaded,
        reset: true,
      }),
    ).rejects.toThrow(/unavailable|unknown|started/);
  });

  it("rejects reset and executed lifecycle history when the epoch is missing", async () => {
    const loaded = loadManifestFromString(manifest);
    const log = new InMemoryRecordLog();
    const snapshot = createManifestSnapshot({
      runId: "run-1",
      manifest: loaded.manifest,
      definition: loaded.def,
      ts: 0,
    });
    const workerLifecycle = {
      type: "session_started" as const,
      run_id: "run-1",
      role: "worker",
      visit_index: 1,
      state: "worker",
      model: "stub:model",
      session_file: "/tmp/worker.jsonl",
      parent_session: null,
      ts: 1,
    };
    await expect(
      admitOrchestratorContextResume({
        runId: "run-1",
        records: [snapshot, workerLifecycle],
        log,
        loadedManifest: loaded,
        reset: false,
      }),
    ).rejects.toThrow(/epoch/);
    await expect(
      admitOrchestratorContextResume({
        runId: "run-1",
        records: [snapshot],
        log,
        loadedManifest: loaded,
        reset: true,
      }),
    ).rejects.toThrow(/epoch/);
  });

  it("rejects a modified committed history before normal resume admission", async () => {
    const loaded = loadManifestFromString(manifest);
    const log = new InMemoryRecordLog();
    const manager = SessionManager.create(
      process.cwd(),
      makeAndTrackIsolatedAgentDir("resume-context-"),
    );
    manager.appendMessage({ role: "user", content: "history", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "anthropic-messages",
      provider: "stub",
      model: "stub-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const leafId = manager.getLeafId();
    const sessionFile = manager.getSessionFile();
    if (leafId === null || sessionFile === undefined) throw new Error("session file setup failed");
    const conversationId = manager.getSessionId();
    const snapshot = createManifestSnapshot({
      runId: "run-1",
      manifest: loaded.manifest,
      definition: loaded.def,
      ts: 1,
    });
    const epoch = {
      schema_version: 1 as const,
      type: "context_epoch_started" as const,
      run_id: "run-1",
      role: "orchestrator",
      epoch: 1,
      reason: "start" as const,
      previous_epoch: null,
      compaction: { enabled: true, reserve_tokens: 100, keep_recent_tokens: 200 },
      ts: 2,
    };
    const invocation = {
      schema_version: 1 as const,
      type: "context_invocation_started" as const,
      run_id: "run-1",
      role: "orchestrator",
      epoch: 1,
      role_session_id: "session-1",
      conversation_id: conversationId,
      session_file: sessionFile,
      model: "stub:model",
      source_boundary: null,
      ts: 3,
    };
    const started = {
      type: "session_started" as const,
      run_id: "run-1",
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: "stub:model",
      session_file: sessionFile,
      parent_session: null,
      role_session_id: "session-1",
      conversation_id: conversationId,
      ts: 4,
    };
    const delivery = {
      schema_version: 1 as const,
      type: "context_delivery_committed" as const,
      run_id: "run-1",
      role: "orchestrator",
      epoch: 1,
      role_session_id: "session-1",
      conversation_id: conversationId,
      session_file: sessionFile,
      delivery_id: "delivery-1",
      seed_sha256: "a".repeat(64),
      leaf_id: leafId,
      ts: 5,
    };
    const terminal = { ...started, type: "session_ended" as const, ts: 6 };
    const captured = await captureOrchestratorContextBoundary({
      roleSessionId: "session-1",
      conversationId,
      sessionFile,
      leafId,
    });
    const boundary = {
      schema_version: 1 as const,
      type: "context_boundary_committed" as const,
      run_id: "run-1",
      role: "orchestrator",
      epoch: 1,
      role_session_id: "session-1",
      conversation_id: conversationId,
      session_file: sessionFile,
      leaf_id: leafId,
      history_sha256: captured.reference.history_sha256,
      ts: 7,
    };
    const records = [snapshot, epoch, invocation, started, delivery, terminal, boundary] as const;
    for (const record of records) log.append(record);
    const original = await readFile(sessionFile, "utf8");
    await writeFile(sessionFile, original.replace("history", "tampered"), "utf8");
    await expect(
      admitOrchestratorContextResume({
        runId: "run-1",
        records: log.records("run-1"),
        log,
        loadedManifest: loaded,
        reset: false,
      }),
    ).rejects.toThrow(/hash|history|mismatch/);
  });

  it("does not append an epoch when public resume cannot acquire the run lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "resume-lease-"));
    const baseDir = join(root, "runs");
    const manifestPath = join(root, "conductor.yaml");
    await writeFile(manifestPath, manifest, "utf8");
    const loaded = loadManifestFromString(manifest);
    const checkpoint = createInitialCheckpoint(loaded.def);
    const log = new FileRecordLog({ baseDir });
    log.append(
      createManifestSnapshot({
        runId: checkpoint.run_id,
        manifest: loaded.manifest,
        definition: loaded.def,
        ts: 1,
      }),
    );
    log.append({ type: "checkpoint_snapshot", checkpoint });
    const lease = await log.acquireRunLease(checkpoint.run_id);
    try {
      await expect(
        resumeRun(manifestPath, checkpoint.run_id, {
          goal: "",
          baseDir,
          hostFactory: () => {
            throw new Error("host must not be constructed while lease is held");
          },
        }),
      ).rejects.toThrow(/lease|active|already/i);
      expect(
        log.records(checkpoint.run_id).some((record) => record.type === "context_epoch_started"),
      ).toBe(false);
    } finally {
      await lease.release();
      log.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
