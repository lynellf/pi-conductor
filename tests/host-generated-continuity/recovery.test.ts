import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TransitionAccepted } from "../../src/core/types.js";
import { createAcceptedControlV2 } from "../../src/host/accepted-control-v2.js";
import { StubHost } from "../../src/host/index.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import { createInitialCheckpoint, FileRecordLog, resumeRun, startRun } from "../../src/index.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { createManifestSnapshot } from "../../src/persistence/trajectory-records.js";
import { materializeWorkObservations } from "../../src/persistence/work-observation.js";
import { makeAndTrackIsolatedAgentDir } from "../host/test-agent-dir.js";

const manifest = `
version: 1
continuity:
  schema_version: 2
  seed_max_utf8_bytes: 32768
  max_observations: 48
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [stub:model]
    tools: [handoff, end]
  - name: worker
    max_visits: 4
    models: [stub:model]
    tools: [handoff, end]
`;
const loaded = loadManifestFromString(manifest);
const runId = "recovery-v2";

function handoff(from: string, to: string, ts: number): TransitionAccepted {
  return {
    type: "transition_accepted",
    run_id: runId,
    from,
    to,
    event: "handoff",
    target_role: to,
    request_end: false,
    end_authority: null,
    end_requested_by: null,
    role: from,
    suggests_next: null,
    payload_summary: { field_names: [] },
    guard: null,
    effect: [],
    session_file: `${from}-session`,
    context_ref: null,
    ts,
    accepted_control: createAcceptedControlV2({
      sourceRole: from,
      orchestratorRole: "orchestrator",
      recipientRole: to,
      reportedArguments: { reason: "continue bounded work" },
    }),
  };
}

function recoveryHistory(): PersistedRecord[] {
  const { accepted_control: _control, ...returned } = handoff("worker", "orchestrator", 4);
  return [
    createManifestSnapshot({ runId, ts: 0, manifest: loaded.manifest, definition: loaded.def }),
    handoff("orchestrator", "worker", 1),
    {
      type: "session_failed",
      run_id: runId,
      role: "worker",
      visit_index: 1,
      state: "worker",
      model: "stub:model",
      session_file: "worker-session",
      parent_session: null,
      failure_reason: "model_error",
      ts: 3,
    },
    {
      ...returned,
      session_file: "<synthesized:handoff:role-unavailable>",
      payload_summary: { reason: "role_unavailable", field_names: ["reason", "role"] },
    },
  ];
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("v2 continuity after host-synthesized model failure recovery", () => {
  it("continues a live v2 run after model exhaustion and dispatch to another available role", async () => {
    const dir = await mkdtemp(join(tmpdir(), "conductor-live-recovery-v2-"));
    dirs.push(dir);
    const manifestPath = join(dir, "manifest.yaml");
    await writeFile(
      manifestPath,
      `${manifest}\n  - name: helper\n    max_visits: 2\n    models: [stub:model]\n    tools: [handoff, end]\n`,
    );
    const baseDir = join(dir, "runs");
    const handle = await startRun(manifestPath, {
      goal: "finish bounded work",
      baseDir,
      hostFactory: ({ runId: id, log, loadedManifest }) =>
        new StubHost({
          runId: id,
          log,
          loadedManifest,
          steps: [
            { kind: "emit_handoff", target_role: "worker" },
            { kind: "fail", errorMessage: "synthetic connection loss" },
            { kind: "emit_handoff", target_role: "helper" },
            { kind: "emit_handoff", target_role: "orchestrator" },
            { kind: "emit_end" },
          ],
          agentDir: makeAndTrackIsolatedAgentDir("conductor-live-recovery-stub-"),
        }),
    });
    expect((await handle.completion()).exitReason).toBe("done");
    const log = new FileRecordLog({ baseDir });
    const observations = materializeWorkObservations(log.records(handle.runId), handle.runId, {
      requireV2Control: true,
    });
    expect(observations.filter((item) => item.source === "host_failure")).toHaveLength(1);
    expect(observations.filter((item) => item.source === "role_return")).toHaveLength(1);
  });

  it("retains the failure without fabricating a worker return or requiring an agent envelope", () => {
    const history = [...recoveryHistory(), handoff("orchestrator", "worker", 5)];
    const before = JSON.stringify(history);
    const observations = materializeWorkObservations(history, runId, { requireV2Control: true });
    expect(observations.map((item) => [item.source, item.observed.terminal])).toEqual([
      ["dispatch", "dispatched"],
      ["host_failure", "failed"],
      ["dispatch", "dispatched"],
    ]);
    expect(observations[1]?.reported_hints.reason).toBe("model_error");
    expect(materializeWorkObservations(history, runId).map((item) => item.source)).toEqual([
      "dispatch",
      "host_failure",
      "role_return",
      "dispatch",
    ]);
    expect(JSON.stringify(history)).toBe(before);
    expect(
      materializeWorkObservations(JSON.parse(before), runId, { requireV2Control: true }),
    ).toEqual(observations);
  });

  it.each([
    "ordinary",
    "no-failure",
    "foreign-failure",
    "wrong-role",
    "wrong-target",
    "wrong-reason",
    "malformed-envelope",
    "later-start",
    "foreign-manifest",
  ])("still rejects missing or malformed control for %s", (variant) => {
    const history = recoveryHistory();
    const index = history.length - 1;
    const synthetic = history[index];
    if (synthetic?.type !== "transition_accepted") throw new Error("fixture");
    if (variant === "ordinary") history[index] = { ...synthetic, session_file: "worker-session" };
    if (variant === "no-failure") history.splice(2, 1);
    if (variant === "foreign-failure")
      history[2] = { ...history[2], run_id: "other-run" } as PersistedRecord;
    if (variant === "wrong-role") history[index] = { ...synthetic, from: "other-worker" };
    if (variant === "wrong-target")
      history[index] = { ...synthetic, to: "worker", target_role: "worker" };
    if (variant === "wrong-reason")
      history[index] = { ...synthetic, payload_summary: { reason: "other", field_names: [] } };
    if (variant === "malformed-envelope")
      history[index] = {
        ...synthetic,
        accepted_control: {
          ...handoff("worker", "orchestrator", 4).accepted_control,
          schema_version: 99,
        } as never,
      };
    if (variant === "later-start")
      history.splice(index, 0, {
        type: "session_started",
        run_id: runId,
        role: "worker",
        visit_index: 2,
        state: "worker",
        model: "stub:model",
        session_file: "new-session",
        parent_session: null,
        ts: 4,
      });
    if (variant === "foreign-manifest")
      history[0] = createManifestSnapshot({
        runId: "other-run",
        ts: 0,
        manifest: loaded.manifest,
        definition: loaded.def,
      });
    expect(() => materializeWorkObservations(history, runId, { requireV2Control: true })).toThrow();
  });

  it.each([
    "orchestrator",
    "worker",
  ])("resumes file-backed history at %s with prior scope intact", async (recipient) => {
    const dir = await mkdtemp(join(tmpdir(), "conductor-recovery-v2-"));
    dirs.push(dir);
    const manifestPath = join(dir, "manifest.yaml");
    await writeFile(manifestPath, manifest);
    const baseDir = join(dir, "runs");
    const log = new FileRecordLog({ baseDir });
    const history = recoveryHistory();
    if (recipient === "worker") history.push(handoff("orchestrator", "worker", 5));
    const initial = createInitialCheckpoint(loaded.def);
    history.push({ type: "run_seeded", run_id: runId, goal: "finish bounded work", ts: 0 });
    history.push({
      type: "checkpoint_snapshot",
      checkpoint: {
        ...initial,
        run_id: runId,
        current_role: recipient,
        visit_count: { worker: recipient === "worker" ? 2 : 1 },
        updated_at: 6,
      },
    });
    for (const record of history) log.append(record);
    const prompts: string[] = [];
    const handle = await resumeRun(manifestPath, runId, {
      baseDir,
      goal: "finish bounded work",
      hostFactory: ({ runId: id, log: records, loadedManifest }) => {
        const host = new StubHost({
          runId: id,
          log: records,
          loadedManifest,
          steps: [
            ...(recipient === "orchestrator"
              ? [{ kind: "emit_handoff" as const, target_role: "worker" }]
              : []),
            { kind: "emit_handoff", target_role: "orchestrator" },
            { kind: "emit_end" },
          ],
          agentDir: makeAndTrackIsolatedAgentDir("conductor-recovery-stub-"),
        });
        const spawn = host.spawnRole.bind(host);
        host.spawnRole = async (role, options) => {
          const session = await spawn(role, options);
          const prompt = session.prompt.bind(session);
          session.prompt = async (text) => {
            prompts.push(text);
            await prompt(text);
          };
          return session;
        };
        return host;
      },
    });
    expect((await handle.completion()).exitReason).toBe("done");
    expect(handle.runId).toBe(runId);
    expect(log.records(runId).slice(0, history.length)).toEqual(history);
    if (recipient === "orchestrator") expect(prompts[0]).toContain("role_unavailable");
    expect(prompts.join("\n")).toContain("model_error");
  });
});
