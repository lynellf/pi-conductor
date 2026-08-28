import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { describe, expect, it, vi } from "vitest";
import {
  createInitialCheckpoint,
  FileRecordLog,
  loadManifest,
  ProductionHost,
  resumeRun,
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

describe("Issue #63 pre-selector trajectory resume", () => {
  it.each([
    {
      name: "after the accepted receiver checkpoint and before the source terminal",
      sourceEnded: false,
    },
    { name: "after the source terminal and before selector durability", sourceEnded: true },
  ])("fails closed $name", async ({ sourceEnded }) => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-trajectory-pre-selector-"));
    const open = vi.spyOn(SessionManager, "open");
    const appendCompaction = vi.spyOn(SessionManager.prototype, "appendCompaction");
    try {
      const baseDir = join(workdir, "runs");
      const manifestPath = join(workdir, ".pi", "conductor.yaml");
      await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
      await writeFile(manifestPath, MANIFEST, "utf8");
      await writeFile(join(workdir, ".pi", "roles", "orchestrator.md"), "ORCHESTRATOR", "utf8");
      await writeFile(join(workdir, ".pi", "roles", "implementer.md"), "IMPLEMENTER", "utf8");

      const loaded = await loadManifest(manifestPath);
      const initial = createInitialCheckpoint(loaded.def);
      const log = new FileRecordLog({ baseDir });
      const requests: unknown[] = [];
      const registry = makeModelRegistryWithStub([], ["stub-model"], (request) =>
        requests.push(request),
      );
      const sourceHost = new ProductionHost({
        modelRegistry: registry,
        cwd: workdir,
        log,
        loadedManifest: loaded,
        runId: initial.run_id,
      });
      const source = await sourceHost.spawnRole("orchestrator");
      await source.prompt("SOURCE_TRAJECTORY_EXACT");
      const sourceConversation = {
        id: source.conversationId ?? source.sessionId,
        file: source.sessionFile,
      };
      await source.dispose();
      const requestsBeforeResume = requests.length;

      log.append(
        createManifestSnapshot({
          runId: initial.run_id,
          manifest: loaded.manifest,
          definition: loaded.def,
          ts: 1,
        }),
      );
      log.append({ type: "run_seeded", run_id: initial.run_id, goal: "resume", ts: 1 });
      log.append({
        type: "session_started",
        run_id: initial.run_id,
        role: "orchestrator",
        visit_index: 1,
        state: "orchestrator",
        model: "stub:stub-model",
        session_file: source.sessionFile,
        parent_session: null,
        role_session_id: source.sessionId,
        conversation_id: sourceConversation.id,
        ts: 2,
      });
      log.append({
        type: "transition_accepted",
        run_id: initial.run_id,
        from: "orchestrator",
        to: "implementer",
        event: "handoff",
        target_role: "implementer",
        request_end: false,
        end_authority: null,
        end_requested_by: null,
        role: "orchestrator",
        suggests_next: null,
        payload_summary: { field_names: [] },
        guard: "visit_count[implementer] < max_visits[implementer]",
        effect: ["visit_count[implementer] += 1"],
        session_file: source.sessionFile,
        ts: 3,
      });
      const targetCheckpoint = {
        ...initial,
        current_role: "implementer" as const,
        visit_count: { implementer: 1 },
        updated_at: 3,
      };
      log.append({ type: "checkpoint_snapshot", checkpoint: targetCheckpoint });
      if (sourceEnded) {
        log.append({
          type: "session_ended",
          run_id: initial.run_id,
          role: "orchestrator",
          visit_index: 1,
          state: "implementer",
          model: "stub:stub-model",
          session_file: source.sessionFile,
          parent_session: null,
          usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
          role_session_id: source.sessionId,
          conversation_id: sourceConversation.id,
          ts: 4,
        });
        log.append({ type: "checkpoint_snapshot", checkpoint: targetCheckpoint });
      }

      let hostFactoryCalls = 0;
      const resume = () =>
        resumeRun(manifestPath, initial.run_id, {
          goal: "ignored",
          baseDir,
          hostFactory: ({ runId, log: resumedLog, loadedManifest }) => {
            hostFactoryCalls += 1;
            return new ProductionHost({
              modelRegistry: registry,
              cwd: workdir,
              log: resumedLog,
              loadedManifest,
              runId,
            });
          },
        });

      await expect(resume()).rejects.toMatchObject({ code: "trajectory_transport_unrecoverable" });
      expect(hostFactoryCalls).toBe(0);
      expect(requests).toHaveLength(requestsBeforeResume);
      expect(open).not.toHaveBeenCalled();
      expect(appendCompaction).not.toHaveBeenCalled();
      expect(
        log.records(initial.run_id).filter((record) => record.type === "session_started"),
      ).toHaveLength(1);
      expect(
        log.records(initial.run_id).filter((record) => record.type === "trajectory_handoff_failed"),
      ).toEqual([
        expect.objectContaining({
          from: "orchestrator",
          to: "implementer",
          source_conversation: sourceConversation,
          code: "trajectory_transport_unrecoverable",
        }),
      ]);

      await expect(resume()).rejects.toMatchObject({ code: "trajectory_transport_unrecoverable" });
      expect(hostFactoryCalls).toBe(0);
      expect(requests).toHaveLength(requestsBeforeResume);
      expect(open).not.toHaveBeenCalled();
      expect(appendCompaction).not.toHaveBeenCalled();
      expect(
        log.records(initial.run_id).filter((record) => record.type === "trajectory_handoff_failed"),
      ).toHaveLength(1);
    } finally {
      open.mockRestore();
      appendCompaction.mockRestore();
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
