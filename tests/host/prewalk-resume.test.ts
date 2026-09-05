import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AuthStorage, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { Checkpoint, MachineDefinition } from "../../src/core/types.js";
import { reconcileCrash } from "../../src/host/api.js";
import type { RoleSession } from "../../src/host/host.js";
import { loadManifestFromString } from "../../src/host/manifest.js";
import {
  createPrewalkResumeRoleSession,
  inspectPrewalkRecovery,
} from "../../src/host/prewalk-resume.js";
import {
  hashPrewalkExecutorEnvironment,
  type PrewalkExecutorEnvironment,
  type PrewalkPhaseSession,
} from "../../src/host/prewalk-role-session.js";
import { ProductionHost } from "../../src/host/production-host.js";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import type {
  PrewalkExecutorSeedDeliveredRecord,
  PrewalkRecord,
  PrewalkSwitchSelectedRecord,
} from "../../src/persistence/prewalk-records.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const execFile = promisify(execFileCallback);

const seed = "[prewalk-provenance]\nresume the persisted checklist";
const environment: PrewalkExecutorEnvironment = {
  model: "local:executor",
  effort: "medium",
  provider: "local",
  api: "openai-completions",
  systemPrompt: "EXECUTOR SYSTEM",
  activeToolNames: ["read", "write", "handoff", "end", "execution_checkpoint"],
  continuationSeed: seed,
};
const selected: PrewalkSwitchSelectedRecord = {
  type: "prewalk_switch_selected",
  schema_version: 1,
  run_id: "run-1",
  role: "worker",
  role_session_id: "prewalk-visit-1",
  transfer_mode: "native",
  guide: {
    model: "openai:guide",
    effort: "high",
    provider: "openai",
    api: "openai-codex-responses",
    conversation: { id: "conversation-1", file: "/sessions/conversation-1.jsonl" },
    turns: 2,
  },
  executor: {
    model: environment.model,
    effort: environment.effort,
    provider: environment.provider,
    api: environment.api,
    system_prompt: environment.systemPrompt,
    active_tool_names: environment.activeToolNames,
    continuation_seed: environment.continuationSeed,
    environment_sha256: hashPrewalkExecutorEnvironment(environment),
    conversation: { id: "conversation-1", file: "/sessions/conversation-1.jsonl" },
  },
  checkpoint: {
    outcome: "handoff_to_executor",
    approach: "continue the recorded implementation",
    rejected_approaches: [],
    todos: [
      {
        task: "finish",
        validation: "pnpm test",
        allowed_paths: ["src/host/prewalk-resume.ts"],
        status: "in_progress",
      },
    ],
    first_edit_path: "src/host/prewalk-resume.ts",
  },
  admission: {
    schema_version: 1,
    target_model: environment.model,
    target_context_window: 100,
    executor_output_reservation: 10,
    executor_envelope_tokens: 10,
    safety_margin_tokens: 10,
    guide_transcript_budget_tokens: 70,
    transformed_tokens: 20,
    required_tokens: 50,
  },
  preflight: {
    requested_mode: "native",
    ok: true,
    repairs: [],
    rejections: [],
    transformed_message_count: 3,
    transformed_tokens: 20,
    reasoning_blocks_dropped: 0,
    thinking_blocks_downgraded: 0,
    assistant_messages_skipped: 0,
    live_probe: "passed",
  },
  guide_usage: { input: 5, output: 2, cache_read: 0, cache_write: 0, tokens: 7, cost: 0.2 },
  git_checkpoint: { base_sha: "a".repeat(40), exemplar_sha: "b".repeat(40) },
  ts: 10,
};

function delivered(overrides: Partial<PrewalkExecutorSeedDeliveredRecord> = {}) {
  return {
    type: "prewalk_executor_seed_delivered" as const,
    schema_version: 1 as const,
    run_id: "run-1",
    role_session_id: selected.role_session_id,
    conversation_id: "conversation-1",
    continuation_seed_sha256: createHash("sha256").update(seed).digest("hex"),
    ts: 11,
    ...overrides,
  };
}

function executor(log: string[]): PrewalkPhaseSession {
  let model = "openai:guide";
  let effort: "high" | "medium" = "high";
  let systemPrompt = "GUIDE SYSTEM";
  let tools = ["read", "write", "execution_checkpoint"];
  const captures: unknown[] = [];
  return {
    role: "worker",
    sessionId: "resumed-lifecycle-session",
    conversationId: "conversation-1",
    sessionFile: "/sessions/conversation-1.jsonl",
    get model() {
      return model;
    },
    get effort() {
      return effort;
    },
    retries: 0,
    retryDelayMs: 0,
    prompt: vi.fn(async (text: string) => {
      log.push(`prompt:${text}`);
    }),
    subscribe: () => () => undefined,
    dispose: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    readCaptureBuffer: () => captures as ReturnType<RoleSession["readCaptureBuffer"]>,
    resetCaptureBuffer: () => captures.splice(0),
    snapshot: () => ({
      isIdle: true,
      autoCompactionEnabled: false,
      checkpointResultDurable: true,
      sideEffectAfterCheckpoint: false,
      model,
      effort,
      provider: model.split(":")[0] ?? "",
      api: model.startsWith("local:") ? "openai-completions" : "openai-codex-responses",
      systemPrompt,
      activeToolNames: [...tools],
    }),
    applyEnvironment: vi.fn(async (next) => {
      log.push("apply");
      model = next.model;
      effort = next.effort;
      systemPrompt = next.systemPrompt;
      tools = [...next.activeToolNames];
    }),
    enableGuideMachineTools: vi.fn(async () => undefined),
  };
}

describe("Prewalk durable resume", () => {
  it("uses the ordinary crash retry before switch selection", () => {
    expect(inspectPrewalkRecovery([], "run-1", "worker")).toBeNull();
  });

  it("reconciles the latest retry when a resumed logical session crashes again", () => {
    const recordLog = new InMemoryRecordLog();
    const def = {
      manifest_version: "v1",
      orchestrator: "orchestrator",
      workers: ["worker"],
      max_visits: { worker: 3 },
      end_request_roles: null,
    } as MachineDefinition;
    const start = (ts: number) => ({
      type: "session_started" as const,
      run_id: "run-1",
      role: "worker",
      visit_index: 1,
      state: "worker" as const,
      model: "local:executor",
      model_effort: "medium" as const,
      session_file: "/sessions/executor.jsonl",
      parent_session: null,
      role_session_id: "prewalk-visit-1",
      conversation_id: "conversation-1",
      ts,
    });
    recordLog.append(start(1));
    recordLog.append({
      type: "session_failed",
      run_id: "run-1",
      role: "worker",
      visit_index: 1,
      state: "worker",
      model: "openai:guide",
      model_effort: "high",
      session_file: "/sessions/guide.jsonl",
      parent_session: null,
      usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 },
      failure_reason: "crashed",
      role_session_id: "prewalk-visit-1",
      conversation_id: "conversation-1",
      ts: 2,
    });
    recordLog.append(start(3));
    const checkpoint: Checkpoint = {
      run_id: "run-1",
      manifest_version: "v1",
      current_role: "worker",
      visit_count: { worker: 1 },
      end_request: null,
      active_role_session: {
        id: "prewalk-visit-1",
        role: "worker",
        session_file: "/sessions/executor.jsonl",
      },
      updated_at: 3,
    };

    reconcileCrash("run-1", checkpoint, def, recordLog);

    expect(
      recordLog
        .records("run-1")
        .filter(
          (record) => record.type === "session_failed" && record.failure_reason === "crashed",
        ),
    ).toHaveLength(2);
  });

  it("restores the persisted executor environment before delivering an undelivered seed", async () => {
    const log: string[] = [];
    const records: PrewalkRecord[] = [];
    const phase = executor(log);
    const recovery = inspectPrewalkRecovery([selected], "run-1", "worker");
    if (recovery === null) throw new Error("expected a selected recovery");

    const session = await createPrewalkResumeRoleSession({
      recovery,
      executor: phase,
      environment,
      persist: (record) => records.push(record),
      now: () => 20,
    });
    expect(session.model).toBe("local:executor");
    expect(session.effort).toBe("medium");

    await session.prompt("the loop's original seed must not be replayed");

    expect(log).toEqual(["apply", `prompt:${seed}`]);
    expect(records).toEqual([
      expect.objectContaining({
        type: "prewalk_executor_seed_delivered",
        role_session_id: selected.role_session_id,
        conversation_id: "conversation-1",
      }),
    ]);
    expect(phase.snapshot()).toMatchObject({
      model: "local:executor",
      effort: "medium",
      systemPrompt: "EXECUTOR SYSTEM",
      activeToolNames: environment.activeToolNames,
    });
  });

  it("recovers a projection selection into a fresh executor conversation", async () => {
    const log: string[] = [];
    const records: PrewalkRecord[] = [];
    const projected: PrewalkSwitchSelectedRecord = {
      ...selected,
      transfer_mode: "projection",
      executor: {
        model: selected.executor.model,
        effort: selected.executor.effort,
        provider: selected.executor.provider,
        api: selected.executor.api,
        system_prompt: selected.executor.system_prompt,
        active_tool_names: selected.executor.active_tool_names,
        continuation_seed: selected.executor.continuation_seed,
        environment_sha256: selected.executor.environment_sha256,
        projection_sha256: "c".repeat(64),
        projection_tokens: 20,
      },
    };
    const recovery = inspectPrewalkRecovery([projected], "run-1", "worker");
    if (recovery === null) throw new Error("expected projection recovery");
    const freshExecutor = executor(log);
    Object.defineProperty(freshExecutor, "conversationId", { value: "fresh-projection" });
    const session = await createPrewalkResumeRoleSession({
      recovery,
      executor: freshExecutor,
      logicalRoleSessionId: projected.role_session_id,
      environment,
      persist: (record) => records.push(record),
    });

    await session.prompt("ignored");

    expect(session.sessionId).toBe(projected.role_session_id);
    expect(log).toEqual(["apply", `prompt:${seed}`]);
    expect(records[0]).toMatchObject({
      type: "prewalk_executor_seed_delivered",
      conversation_id: "fresh-projection",
    });
  });

  it("never delivers the continuation seed twice after its durable marker", async () => {
    const log: string[] = [];
    const records: PrewalkRecord[] = [];
    const recovery = inspectPrewalkRecovery([selected, delivered()], "run-1", "worker");
    if (recovery === null) throw new Error("expected a delivered recovery");
    const session = await createPrewalkResumeRoleSession({
      recovery,
      executor: executor(log),
      environment,
      persist: (record) => records.push(record),
    });

    await session.prompt("ignored");
    await session.prompt("ordinary correction");

    expect(log[0]).toBe("apply");
    expect(log.filter((entry) => entry === `prompt:${seed}`)).toHaveLength(0);
    expect(log[1]).toContain("prompt:[prewalk-resume]");
    expect(log[2]).toBe("prompt:ordinary correction");
    expect(records).toHaveLength(0);
  });

  it("persists and surfaces prewalk_resume_invalid when environment restoration fails", async () => {
    const log: string[] = [];
    const records: PrewalkRecord[] = [];
    const phase = executor(log);
    phase.applyEnvironment = vi.fn(async () => {
      throw new Error("SDK refused the persisted environment");
    });
    const recovery = inspectPrewalkRecovery([selected], "run-1", "worker");
    if (recovery === null) throw new Error("expected recovery");

    await expect(
      createPrewalkResumeRoleSession({
        recovery,
        executor: phase,
        environment,
        persist: (record) => records.push(record),
      }),
    ).rejects.toMatchObject({ code: "prewalk_resume_invalid" });

    expect(records).toEqual([
      expect.objectContaining({
        type: "prewalk_switch_failed",
        code: "prewalk_resume_invalid",
        git_checkpoint: selected.git_checkpoint,
      }),
    ]);
  });

  it.each([
    {
      name: "a mismatched seed hash",
      records: [selected, delivered({ continuation_seed_sha256: "f".repeat(64) })],
    },
    {
      name: "duplicate delivery markers",
      records: [selected, delivered(), delivered({ ts: 12 })],
    },
    {
      name: "a tampered environment",
      records: [
        {
          ...selected,
          executor: { ...selected.executor, system_prompt: "TAMPERED" },
        },
      ],
    },
  ])("classifies $name as prewalk_resume_invalid", ({ records }) => {
    expect(() => inspectPrewalkRecovery(records, "run-1", "worker")).toThrowError(
      expect.objectContaining({ code: "prewalk_resume_invalid" }),
    );
  });

  it("ProductionHost reopens the selected conversation on the executor model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-prewalk-resume-"));
    try {
      await execFile("git", ["init", "--quiet"], { cwd });
      await writeFile(join(cwd, "README.md"), "base\n", "utf8");
      await mkdir(join(cwd, ".pi", "roles"), { recursive: true });
      await writeFile(join(cwd, ".pi", "roles", "worker.md"), "EXECUTOR SYSTEM", "utf8");
      await execFile("git", ["add", "."], { cwd });
      await execFile(
        "git",
        [
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "base",
        ],
        { cwd },
      );

      const requests: unknown[] = [];
      const requestModels: string[] = [];
      const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
      const base = makeStubModel();
      const stream = makeStubStreamFunction({
        steps: [{ kind: "emit_handoff", target_role: "orchestrator", reason: "resumed" }],
        onRequest: (request) => requests.push(request),
      });
      registry.registerProvider("stub", {
        api: "openai-completions",
        apiKey: "stub-key",
        baseUrl: base.baseUrl,
        streamSimple: (model, context, options) => {
          requestModels.push(model.id);
          return stream(model, context, options);
        },
        models: ["guide", "executor"].map((id) => ({
          ...base,
          id,
          name: id,
          api: "openai-completions" as const,
        })),
      });
      const yaml = `
version: 2
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 2
    max_session_cost_usd: 8
    models:
      - model: stub:executor
        effort: off
    system_prompt: roles/worker.md
    tools: [read, handoff, end]
    prewalk:
      validation_allowlist: [git]
      guide:
        model: stub:guide
        effort: off
        max_cost_usd: 2
        max_turns: 4
      executor:
        max_turns: 20
        max_wall_clock_s: 60
`;
      const validationContext = {
        prewalk: {
          worker: {
            executor_context_window: 200_000,
            executor_max_tokens: 8_192,
            executor_envelope_tokens: 1_000,
            safety_margin_tokens: 20_000,
            workspace_is_git_repository: true,
          },
        },
      } as const;
      const loaded = loadManifestFromString(yaml, join(cwd, ".pi"), registry, validationContext);
      const sessionDir = join(cwd, "sessions");
      await mkdir(sessionDir, { recursive: true });
      const manager = SessionManager.create(cwd, sessionDir, { id: "guide-conversation" });
      manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "ORIGINAL TASK" }],
        timestamp: 1,
      });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "checkpoint sealed" }],
        provider: "stub",
        api: "openai-completions",
        model: "guide",
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
      const sessionFile = manager.getSessionFile();
      if (sessionFile === undefined) throw new Error("expected a persisted guide session");
      const resumedEnvironment: PrewalkExecutorEnvironment = {
        model: "stub:executor",
        effort: "off",
        provider: "stub",
        api: "openai-completions",
        systemPrompt: "EXECUTOR SYSTEM",
        activeToolNames: ["read", "handoff", "end", "ask_user", "execution_checkpoint"],
        continuationSeed: seed,
      };
      const durableSelection: PrewalkSwitchSelectedRecord = {
        ...selected,
        guide: {
          ...selected.guide,
          model: "stub:guide",
          effort: "off",
          provider: "stub",
          api: "openai-completions",
          conversation: { id: manager.getSessionId(), file: sessionFile },
        },
        executor: {
          model: resumedEnvironment.model,
          effort: resumedEnvironment.effort,
          provider: resumedEnvironment.provider,
          api: resumedEnvironment.api,
          system_prompt: resumedEnvironment.systemPrompt,
          active_tool_names: resumedEnvironment.activeToolNames,
          continuation_seed: resumedEnvironment.continuationSeed,
          environment_sha256: hashPrewalkExecutorEnvironment(resumedEnvironment),
          conversation: { id: manager.getSessionId(), file: sessionFile },
        },
        checkpoint: {
          ...selected.checkpoint,
          todos: selected.checkpoint.todos.map((todo) => ({
            ...todo,
            validation: "git diff --check",
          })),
        },
        admission: { ...selected.admission, target_model: resumedEnvironment.model },
      };
      const recordLog = new InMemoryRecordLog();
      recordLog.append(durableSelection);
      const host = new ProductionHost({
        modelRegistry: registry,
        cwd,
        log: recordLog,
        loadedManifest: loaded,
        runId: "run-1",
        sessionDir,
        agentDir: makeAndTrackIsolatedAgentDir(),
      });

      const session = await host.spawnRole("worker", { visitIndex: 1 });
      await session.prompt("LOOP SEED MUST BE IGNORED");

      expect(session.sessionId).toBe(selected.role_session_id);
      expect(session.model).toBe("stub:executor");
      expect(session.conversationId).toBe("guide-conversation");
      expect(host.captureUsage(session)).toMatchObject(selected.guide_usage);
      expect(session.readCaptureBuffer()).toHaveLength(1);
      expect(requests).toHaveLength(1);
      expect(requestModels).toEqual(["executor"]);
      expect(recordLog.records("run-1")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "prewalk_executor_seed_delivered" }),
          expect.objectContaining({ type: "prewalk_phase_usage", model: "stub:executor" }),
        ]),
      );
      await session.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stops considering the selection after the role transitions", () => {
    expect(
      inspectPrewalkRecovery(
        [
          selected,
          {
            type: "transition_accepted",
            run_id: "run-1",
            event: "handoff",
            from: "worker",
            to: "orchestrator",
            target_role: "orchestrator",
            request_end: false,
            end_authority: null,
            end_requested_by: null,
            role: "worker",
            suggests_next: null,
            payload_summary: { field_names: ["reason"] },
            guard: null,
            effect: [],
            session_file: "/sessions/conversation-1.jsonl",
            ts: 15,
          },
        ],
        "run-1",
        "worker",
      ),
    ).toBeNull();
  });
});
