import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { StubStep } from "../../src/host/stub-provider.js";
import { makeStubModel } from "../../src/host/stub-provider.js";
import {
  createInitialCheckpoint,
  FileRecordLog,
  InMemoryRecordLog,
  loadManifestFromString,
  ProductionHost,
  resumeRun,
} from "../../src/index.js";
import { createManifestSnapshot } from "../../src/persistence/trajectory-records.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const hangingCommand = (): string =>
  `${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(() => {}, 2_000)")}`;
const longHangingCommand = (): string =>
  `${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(() => {}, 3_000)")}`;

const MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:stub-model, effort: off }]
    system_prompt: .pi/roles/worker.md
    tools: [handoff, end]
  - name: worker
    max_visits: 3
    max_session_cost_usd: 10
    models: [{ model: stub:stub-model, effort: off }]
    system_prompt: .pi/roles/worker.md
    tools: [bash, handoff, end]
    tool_execution:
      timeout_seconds: 1
      max_recoverable_timeouts: 1
      termination_grace_seconds: 1
`;
const TRAJECTORY_MANIFEST = MANIFEST.replace(
  "    tools: [bash, handoff, end]",
  "    tools: [handoff, end]",
);
const EXHAUSTED_RESUME_MANIFEST = MANIFEST.replace(
  "    tools: [handoff, end]",
  "    tools: [bash, handoff, end]\n    tool_execution: { timeout_seconds: 1, max_recoverable_timeouts: 1, termination_grace_seconds: 1 }",
);

const directories: string[] = [];

async function makeHostWithLog(
  log: InMemoryRecordLog,
  steps: readonly StubStep[] = [],
  manifestText = MANIFEST,
): Promise<ProductionHost> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-shared-host-"));
  directories.push(cwd);
  await mkdir(join(cwd, ".pi", "roles"), { recursive: true });
  await writeFile(join(cwd, ".pi", "roles", "worker.md"), "worker", "utf8");
  return new ProductionHost({
    modelRegistry: makeModelRegistryWithStub(steps),
    cwd,
    log,
    loadedManifest: loadManifestFromString(manifestText, cwd),
    runId: "shared-host-run",
    agentDir: makeAndTrackIsolatedAgentDir(),
  });
}

describe("shared SDK supervised executable tools", () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("surfaces timeout exhaustion to the host before lifecycle reduction", async () => {
    const log = new InMemoryRecordLog();
    const host = await makeHostWithLog(log, [
      {
        kind: "emit_tool_calls",
        calls: [{ name: "bash", arguments: { command: hangingCommand() } }],
      },
      { kind: "emit_text", text: "first complete" },
      {
        kind: "emit_tool_calls",
        calls: [{ name: "bash", arguments: { command: hangingCommand() } }],
      },
      { kind: "emit_text", text: "second complete" },
    ]);
    const session = await host.spawnRole("worker");
    try {
      await session.prompt("first supervised operation");
      expect(host.sessionTerminalReason(session)).toBe(null);
      await session.prompt("second supervised operation");
      expect(host.sessionTerminalReason(session)).toBe("tool_timeout_exhausted");
      const detail = host.sessionFailureDetail(session);
      expect(detail).toContain('"executionId":"');
      expect(detail).toContain("The operation was not replayed");
      expect(session.readCaptureBuffer()).toHaveLength(0);
      expect(log.records("shared-host-run").some((record) => record.type === "session_ended")).toBe(
        false,
      );
    } finally {
      await session.dispose();
    }
  });

  it("carries recoverable timeout counts into a fresh shared host session", async () => {
    const log = new InMemoryRecordLog();
    const firstHost = await makeHostWithLog(log, [
      {
        kind: "emit_tool_calls",
        calls: [{ name: "bash", arguments: { command: hangingCommand() } }],
      },
      { kind: "emit_text", text: "first complete" },
    ]);
    const first = await firstHost.spawnRole("worker", { visitIndex: 1 });
    await first.prompt("first supervised operation");
    await first.dispose();

    const secondHost = await makeHostWithLog(log, [
      {
        kind: "emit_tool_calls",
        calls: [{ name: "bash", arguments: { command: hangingCommand() } }],
      },
      { kind: "emit_text", text: "second complete" },
    ]);
    const second = await secondHost.spawnRole("worker", { visitIndex: 1 });
    try {
      await second.prompt("second supervised operation");
      expect(secondHost.sessionTerminalReason(second)).toBe("tool_timeout_exhausted");
    } finally {
      await second.dispose();
    }
  });

  it("registers a newly activated trajectory tool with the target policy", async () => {
    const log = new InMemoryRecordLog();
    const host = await makeHostWithLog(
      log,
      [
        {
          kind: "emit_tool_calls",
          calls: [{ name: "bash", arguments: { command: longHangingCommand() } }],
        },
        { kind: "emit_text", text: "target complete" },
      ],
      TRAJECTORY_MANIFEST,
    );
    const source = await host.spawnRole("worker");
    try {
      expect(source.getTrajectoryContext?.()?.registeredToolNames).toContain("bash");
      const target = await source.continueTrajectory?.({
        role: "worker",
        model: makeStubModel() as never,
        logicalModel: "stub:stub-model",
        effort: "off",
        systemPrompt: "worker",
        activeToolNames: ["bash", "handoff", "end"],
        visitIndex: 2,
        maxSessionCostUsd: null,
        toolExecutionPolicy: {
          timeout_seconds: 2,
          max_recoverable_timeouts: 2,
          termination_grace_seconds: 2,
        },
      });
      if (target === undefined) throw new Error("trajectory continuation unavailable");
      try {
        await target.prompt("target supervised operation");
        expect(host.sessionTerminalReason(target)).toBe(null);
        expect(
          log
            .records("shared-host-run")
            .some(
              (record) => record.type === "tool_execution_started" && record.timeout_ms === 2_000,
            ),
        ).toBe(true);
      } finally {
        await target.dispose();
      }
    } finally {
      await source.dispose();
    }
  });

  it("uses the target execution index when trajectory source and target visits differ", async () => {
    const log = new InMemoryRecordLog();
    const host = await makeHostWithLog(log, [
      {
        kind: "emit_tool_calls",
        calls: [{ name: "bash", arguments: { command: "printf source" } }],
      },
      { kind: "emit_text", text: "source complete" },
      {
        kind: "emit_tool_calls",
        calls: [{ name: "bash", arguments: { command: "printf target" } }],
      },
      { kind: "emit_text", text: "target complete" },
    ]);
    const source = await host.spawnRole("worker", { visitIndex: 1, executionVisitIndex: 4 });
    try {
      await source.prompt("source operation");
      const target = await source.continueTrajectory?.({
        role: "worker",
        model: makeStubModel() as never,
        logicalModel: "stub:stub-model",
        effort: "off",
        systemPrompt: "worker",
        activeToolNames: ["bash", "handoff", "end"],
        visitIndex: 2,
        executionVisitIndex: 9,
        maxSessionCostUsd: null,
      });
      if (target === undefined) throw new Error("trajectory continuation unavailable");
      try {
        await target.prompt("target operation");
        const identities = log
          .records("shared-host-run")
          .filter((record) => record.type === "tool_execution_started")
          .map((record) => record.logical_session_id);
        expect(identities).toContain(JSON.stringify(["shared-host-run", "worker", 4]));
        expect(identities).toContain(JSON.stringify(["shared-host-run", "worker", 9]));
      } finally {
        await target.dispose();
      }
    } finally {
      await source.dispose();
    }
  });

  it("blocks resume on an unfinished execution before constructing a host", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-shared-resume-"));
    directories.push(workdir);
    const baseDir = join(workdir, "records");
    const manifestPath = join(workdir, "conductor.yaml");
    await writeFile(manifestPath, EXHAUSTED_RESUME_MANIFEST, "utf8");
    await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
    await writeFile(join(workdir, ".pi", "roles", "worker.md"), "worker", "utf8");
    const loaded = loadManifestFromString(EXHAUSTED_RESUME_MANIFEST, workdir);
    const runId = "unknown-owner-run";
    const log = new FileRecordLog({ baseDir });
    log.append(
      createManifestSnapshot({ runId, manifest: loaded.manifest, definition: loaded.def, ts: 1 }),
    );
    log.append({
      type: "checkpoint_snapshot",
      checkpoint: { ...createInitialCheckpoint(loaded.def), run_id: runId },
    });
    log.append({ type: "run_seeded", run_id: runId, goal: "resume", ts: 2 });
    log.append({
      type: "tool_execution_started",
      schema_version: 1,
      run_id: runId,
      execution_id: "execution-1",
      supervision_id: "supervision-1",
      logical_session_id: JSON.stringify([runId, "worker", 1]),
      role_session_id: "role-session-1",
      tool_call_id: "tool-call-1",
      tool_name: "bash",
      timeout_ms: 1_000,
      recovery_count: 1,
      ts: 3,
    });
    let factoryCalls = 0;
    await expect(
      resumeRun(manifestPath, runId, {
        baseDir,
        goal: "resume",
        hostFactory: () => {
          factoryCalls += 1;
          throw new Error("host must not be constructed");
        },
      }),
    ).rejects.toMatchObject({ code: "tool_resume_unknown_owner" });
    expect(factoryCalls).toBe(0);
  });

  it("blocks same-process replacement when durable cleanup ownership is unknown", async () => {
    const log = new InMemoryRecordLog();
    log.append({
      type: "tool_execution_started",
      schema_version: 1,
      run_id: "shared-host-run",
      execution_id: "live-execution",
      supervision_id: "live-supervision",
      logical_session_id: JSON.stringify(["shared-host-run", "worker", 1]),
      role_session_id: "live-role-session",
      tool_call_id: "live-tool-call",
      tool_name: "bash",
      timeout_ms: 1_000,
      recovery_count: 0,
      ts: 1,
    });
    const host = await makeHostWithLog(log);
    await expect(host.spawnRole("worker", { visitIndex: 1 })).rejects.toMatchObject({
      code: "tool_resume_unknown_owner",
    });
  });

  it("resumes an exhausted confirmed invocation with a fresh visit allowance", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-shared-resume-fresh-"));
    directories.push(workdir);
    const baseDir = join(workdir, "records");
    const manifestPath = join(workdir, "conductor.yaml");
    await writeFile(manifestPath, EXHAUSTED_RESUME_MANIFEST, "utf8");
    await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
    await writeFile(join(workdir, ".pi", "roles", "worker.md"), "worker", "utf8");
    const loaded = loadManifestFromString(EXHAUSTED_RESUME_MANIFEST, workdir);
    const runId = "fresh-resume-run";
    const log = new FileRecordLog({ baseDir });
    log.append(
      createManifestSnapshot({ runId, manifest: loaded.manifest, definition: loaded.def, ts: 1 }),
    );
    log.append({
      type: "checkpoint_snapshot",
      checkpoint: {
        ...createInitialCheckpoint(loaded.def),
        run_id: runId,
        current_role: "orchestrator",
        active_role_session: null,
        visit_count: { orchestrator: 1, worker: 0 },
      },
    });
    log.append({ type: "run_seeded", run_id: runId, goal: "resume exhausted work", ts: 2 });
    log.append({
      type: "session_started",
      run_id: runId,
      role: "orchestrator",
      visit_index: 1,
      state: "orchestrator",
      model: "stub:stub-model",
      session_file: "<prior-session>",
      parent_session: null,
      ts: 3,
    });
    log.append({
      type: "tool_execution_started",
      schema_version: 1,
      run_id: runId,
      execution_id: "execution-finished-1",
      supervision_id: "supervision-1",
      logical_session_id: JSON.stringify([runId, "orchestrator", 1]),
      role_session_id: "prior-session",
      tool_call_id: "tool-call-1",
      tool_name: "bash",
      timeout_ms: 1_000,
      recovery_count: 0,
      ts: 3.5,
    });
    log.append({
      type: "tool_execution_finished",
      schema_version: 1,
      run_id: runId,
      execution_id: "execution-finished-1",
      supervision_id: "supervision-1",
      logical_session_id: JSON.stringify([runId, "orchestrator", 1]),
      role_session_id: "prior-session",
      tool_call_id: "tool-call-1",
      tool_name: "bash",
      elapsed_ms: 1_000,
      recovery_count: 0,
      outcome: "timed_out",
      cleanup: "confirmed",
      ts: 4,
    });
    log.append({
      type: "tool_execution_started",
      schema_version: 1,
      run_id: runId,
      execution_id: "execution-finished-2",
      supervision_id: "supervision-2",
      logical_session_id: JSON.stringify([runId, "orchestrator", 1]),
      role_session_id: "prior-session",
      tool_call_id: "tool-call-2",
      tool_name: "bash",
      timeout_ms: 1_000,
      recovery_count: 1,
      ts: 4.5,
    });
    log.append({
      type: "tool_execution_finished",
      schema_version: 1,
      run_id: runId,
      execution_id: "execution-finished-2",
      supervision_id: "supervision-2",
      logical_session_id: JSON.stringify([runId, "orchestrator", 1]),
      role_session_id: "prior-session",
      tool_call_id: "tool-call-2",
      tool_name: "bash",
      elapsed_ms: 1_000,
      recovery_count: 1,
      outcome: "timed_out",
      cleanup: "confirmed",
      ts: 5,
    });
    let executionVisitIndex: number | undefined;
    let workspaceVisitIndex: number | undefined;
    const handle = await resumeRun(manifestPath, runId, {
      baseDir,
      goal: "resume exhausted work",
      hostFactory: (context) => {
        const host = new ProductionHost({
          modelRegistry: makeModelRegistryWithStub([
            {
              kind: "emit_tool_calls",
              calls: [{ name: "bash", arguments: { command: "printf resumed" } }],
            },
            { kind: "emit_end", reason: "resumed" },
          ]),
          cwd: workdir,
          log: context.log,
          loadedManifest: context.loadedManifest,
          runId: context.runId,
          agentDir: makeAndTrackIsolatedAgentDir(),
        });
        const spawn = host.spawnRole.bind(host);
        host.spawnRole = async (role, options) => {
          workspaceVisitIndex = options?.visitIndex;
          executionVisitIndex = options?.executionVisitIndex;
          return spawn(role, options);
        };
        return host;
      },
    });
    const completion = await handle.completion();
    expect(completion.exitReason, JSON.stringify({ completion, records: log.records(runId) })).toBe(
      "done",
    );
    expect(workspaceVisitIndex).toBe(1);
    expect(executionVisitIndex).toBe(2);
    expect(
      log
        .records(runId)
        .some(
          (record) =>
            record.type === "tool_execution_finished" &&
            record.tool_call_id !== "tool-call-1" &&
            record.tool_call_id !== "tool-call-2" &&
            record.logical_session_id === JSON.stringify([runId, "orchestrator", 2]) &&
            record.outcome === "completed",
        ),
    ).toBe(true);
  });
});
