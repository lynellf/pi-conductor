import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Message, Model } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  type ProductionPrewalkPhaseSpawnOptions,
  spawnProductionPrewalkRoleSession,
} from "../../src/host/prewalk-manifest-context.js";
import type { PrewalkPhaseSession } from "../../src/host/prewalk-role-session.js";
import { makeStubModel } from "../../src/host/stub-provider.js";
import type { PrewalkConfig } from "../../src/manifest/types.js";
import type { PersistedRecord } from "../../src/persistence/log.js";

const execFile = promisify(execFileCallback);
const zeroUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0, tokens: 0, cost: 0 };

async function fixture(options: {
  tokens: number[];
  maxTurns?: number;
  cost?: number;
  checkpoint?: boolean;
}) {
  const cwd = await mkdtemp(join(tmpdir(), "prewalk-guide-control-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await execFile("git", ["init", "--quiet"], { cwd });
  await writeFile(join(cwd, "example.txt"), "base\n");
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
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const model = { ...makeStubModel(), api: "openai-completions" as const };
  registry.registerProvider("stub", {
    api: "openai-completions",
    apiKey: "stub",
    baseUrl: model.baseUrl,
    models: ["guide", "executor"].map((id) => ({ ...model, id, name: id })),
  });
  const config: PrewalkConfig = {
    transfer: "native",
    on_preflight_failure: "fail",
    visits: "first",
    max_todos: 12,
    executor_output_reservation: 1,
    validation_retries: 2,
    validation_allowlist: ["git"],
    guide: {
      model: "stub:guide",
      effort: "off",
      max_cost_usd: 2,
      max_turns: options.maxTurns ?? 10,
    },
    executor: { max_turns: 20, max_wall_clock_s: 600 },
  };
  const records: PersistedRecord[] = [];
  const steers: string[] = [];
  const opened: string[] = [];
  let completedTurns = 0;
  let aborted = false;
  let consumed = 0;
  const session = await spawnProductionPrewalkRoleSession({
    runId: "run",
    role: "worker",
    roleSessionId: "logical",
    visitIndex: 1,
    cwd,
    roleConfig: {
      name: "worker",
      max_visits: 2,
      models: [{ model: "stub:executor", effort: "off" }],
      tools: ["read", "write", "handoff"],
      prewalk: config,
    },
    seedModel: { logical: "stub:executor", model: { ...model, id: "executor" } as Model<never> },
    baseSystemPrompt: "BASE",
    modelRegistry: registry,
    validationContext: {
      executor_context_window: 1001,
      executor_max_tokens: 1,
      executor_envelope_tokens: 0,
      safety_margin_tokens: 0,
      workspace_is_git_repository: true,
    },
    records: () => records,
    persist: (record) => records.push(record),
    registerUsageSession: () => undefined,
    usageFor: () => ({ ...zeroUsage, cost: options.cost ?? 0 }),
    markTerminalFailure: () => undefined,
    spawnPhase: async (phase: ProductionPrewalkPhaseSpawnOptions) => {
      opened.push(phase.kind);
      let env = {
        model: phase.logicalModel,
        effort: phase.effort,
        provider: "stub",
        api: "openai-completions",
        systemPrompt: phase.systemPrompt,
        activeToolNames: (phase.kind === "guide"
          ? ["read", "write", "execution_checkpoint"]
          : [
              "read",
              "write",
              "handoff",
              "end",
              "ask_user",
              "execution_checkpoint",
            ]) as readonly string[],
      };
      const listeners = new Set<Parameters<PrewalkPhaseSession["subscribe"]>[0]>();
      const history: { id: string; message: Message }[] = [];
      const physical: PrewalkPhaseSession = {
        role: "worker",
        sessionId: phase.roleSessionId,
        conversationId: phase.roleSessionId,
        sessionFile: join(cwd, phase.roleSessionId),
        model: phase.logicalModel,
        effort: phase.effort,
        retries: 0,
        retryDelayMs: 0,
        deliveryHistory: () => history,
        snapshot: () => ({
          ...env,
          isIdle: true,
          autoCompactionEnabled: false,
          checkpointResultDurable: true,
          sideEffectAfterCheckpoint: false,
        }),
        preflightContext: () => ({
          messages: [{ role: "user", content: "x".repeat(consumed * 4), timestamp: 0 }],
          registeredTools: [],
          contextTokens: 1,
          hasCompaction: false,
        }),
        applyEnvironment: async (next) => {
          env = { ...next };
        },
        enableGuideMachineTools: async () => undefined,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispose: async () => undefined,
        abort: async () => {
          aborted = true;
        },
        steer: async (text) => {
          steers.push(text);
        },
        clearQueue: () => ({ steering: [], followUp: [] }),
        readCaptureBuffer: () => [],
        resetCaptureBuffer: () => undefined,
        prompt: async (text) => {
          history.push({
            id: String(history.length),
            message: { role: "user", content: text, timestamp: 0 },
          });
          if (env.model !== "stub:guide") return;
          await writeFile(join(cwd, "example.txt"), "exemplar\n");
          for (const [index, tokens] of options.tokens.entries()) {
            consumed = tokens;
            completedTurns += 1;
            if (index === options.tokens.length - 1 && options.checkpoint !== false)
              phase.seam.record({
                outcome: "handoff_to_executor",
                approach: "Finish exemplar",
                rejected_approaches: [],
                first_edit_path: "example.txt",
                todos: [
                  {
                    task: "verify",
                    validation: "git diff --check",
                    allowed_paths: ["example.txt"],
                    status: "pending",
                  },
                ],
              });
            for (const listener of listeners)
              listener({ type: "turn_end" } as Parameters<typeof listener>[0]);
            if (aborted) break;
          }
        },
      };
      return physical;
    },
  });
  return {
    session,
    records,
    steers,
    opened,
    cwd,
    turns: () => completedTurns,
    aborted: () => aborted,
  };
}

describe("production-composed Prewalk guide limits", () => {
  it("preserves work and fails explicitly if budget exhaustion precedes a valid checklist", async () => {
    const f = await fixture({ tokens: [1200], checkpoint: false });
    await expect(f.session.prompt("TASK")).rejects.toMatchObject({
      code: "prewalk_checkpoint_missing",
    });
    expect(f.opened).toEqual(["guide"]);
    expect(f.records.find((record) => record.type === "prewalk_switch_failed")).toMatchObject({
      git_checkpoint: { exemplar_sha: expect.any(String) },
    });
  });
  it("issues exactly one convergence steer from executor transcript consumption, not guide usage", async () => {
    const f = await fixture({ tokens: [800, 850, 900] });
    await f.session.prompt("TASK");
    expect(f.steers).toHaveLength(1);
    expect(f.steers[0]).toContain("75%");
    expect(f.records.find((record) => record.type === "prewalk_switch_selected")).toMatchObject({
      guide: { turns: 3 },
    });
  });
  it("stops an over-budget guide and forces projection even with native/fail configured", async () => {
    const f = await fixture({ tokens: [1200] });
    await f.session.prompt("TASK");
    expect(f.aborted()).toBe(true);
    expect(f.opened).toEqual(["guide", "executor"]);
    expect(f.records.find((record) => record.type === "prewalk_switch_selected")).toMatchObject({
      transfer_mode: "projection",
    });
    expect(f.records.some((record) => /^(transition_|session_)/.test(record.type))).toBe(false);
  });
  it.each([
    { code: "prewalk_guide_turn_cap_exceeded", maxTurns: 1, cost: 0 },
    { code: "prewalk_guide_cost_cap_exceeded", maxTurns: 10, cost: 3 },
  ])("fails with $code and preserves guide usage and recoverable exemplar", async ({
    code,
    maxTurns,
    cost,
  }) => {
    const f = await fixture({ tokens: [50, 60, 70], maxTurns, cost });
    await expect(f.session.prompt("TASK")).rejects.toMatchObject({ code });
    expect(f.turns()).toBe(1);
    expect(f.opened).toEqual(["guide"]);
    const failure = f.records.find((record) => record.type === "prewalk_switch_failed");
    expect(failure).toMatchObject({
      code,
      guide_usage: { cost },
      git_checkpoint: { exemplar_sha: expect.any(String) },
    });
    if (failure?.type !== "prewalk_switch_failed") throw new Error("expected failure");
    const { stdout } = await execFile(
      "git",
      ["show", `${failure.git_checkpoint.exemplar_sha}:example.txt`],
      { cwd: f.cwd },
    );
    expect(stdout).toBe("exemplar\n");
    expect(f.records.some((record) => /^(transition_|session_)/.test(record.type))).toBe(false);
  });
});
