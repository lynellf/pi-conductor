import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StreamFunction } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifestFromString } from "../../src/host/manifest.js";
import { ProductionHost } from "../../src/host/production-host.js";
import {
  makeStubModel,
  makeStubStreamFunction,
  type StubStep,
} from "../../src/host/stub-provider.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];

// Pi forwards its aborted signal to the next stream call; the ordinary scripted
// stub ignores that signal. Model provider cancellation here without further work.
function abortAware(stream: StreamFunction): StreamFunction {
  return (model, context, options) =>
    options?.signal?.aborted
      ? makeStubStreamFunction({ steps: [{ kind: "fail", errorMessage: "aborted" }] })(
          model,
          context,
          options,
        )
      : stream(model, context, options);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Production Prewalk execution ownership review", () => {
  it.each([
    { transfer: "native", reason: "model_error" },
    { transfer: "projection", reason: "model_error" },
    { transfer: "native", reason: "session_cost_cap_exceeded" },
    { transfer: "projection", reason: "session_cost_cap_exceeded" },
  ] as const)("does not launch validation after $reason in $transfer fresh/resumed executors", async ({
    transfer,
    reason,
  }) => {
    const guideMaxTurns = 4;
    const terminalStep: StubStep =
      reason === "model_error"
        ? { kind: "fail", errorMessage: "executor provider failed" }
        : {
            kind: "emit_text",
            text: "executor reached its budget",
            usage: { cost: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0, total: 9 } },
          };
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-production-prewalk-"));
    roots.push(cwd);
    await execFile("git", ["init", "--quiet"], { cwd });
    await writeFile(join(cwd, "README.md"), "UNCHANGED GUIDE READ\n", "utf8");
    await writeFile(join(cwd, "example.txt"), "old exemplar\n", "utf8");
    await mkdir(join(cwd, ".pi", "roles"), { recursive: true });
    await writeFile(join(cwd, ".pi", "roles", "worker.md"), "WORKER BASE", "utf8");
    await execFile("git", ["add", "README.md", "example.txt", ".pi/roles/worker.md"], { cwd });
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

    const checkpoint = {
      outcome: "handoff_to_executor",
      approach: "Write one exemplar, then verify the remainder.",
      rejected_approaches: ["new FSM state"],
      todos: [
        {
          task: "verify exemplar",
          validation: "git diff --check",
          allowed_paths: ["example.txt"],
          status: "in_progress",
        },
      ],
      first_edit_path: "example.txt",
    };
    const requests: unknown[] = [];
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    const base = makeStubModel();
    registry.registerProvider("stub", {
      api: "openai-completions",
      apiKey: "stub-key",
      baseUrl: base.baseUrl,
      streamSimple: abortAware(
        makeStubStreamFunction({
          steps: [
            {
              kind: "emit_tool_calls",
              calls: [
                { name: "read", arguments: { path: "README.md" } },
                { name: "read", arguments: { path: "example.txt" } },
              ],
            },
            {
              kind: "emit_tool_calls",
              calls: [{ name: "write", arguments: { path: "example.txt", content: "guide\n" } }],
            },
            {
              kind: "emit_tool_calls",
              calls: [{ name: "execution_checkpoint", arguments: checkpoint }],
            },
            terminalStep,
            terminalStep,
          ],
          onRequest: (request) => requests.push(request),
        }),
      ),
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
    tools: [read, write, bash, handoff, end]
    prewalk:
      transfer: ${transfer}
      validation_allowlist: [git]
      guide:
        model: stub:guide
        effort: off
        max_cost_usd: 2
        max_turns: ${guideMaxTurns}
      executor:
        max_turns: 20
        max_wall_clock_s: 600
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
    const log = new InMemoryRecordLog();
    const host = new ProductionHost({
      modelRegistry: registry,
      cwd,
      log,
      loadedManifest: loaded,
      runId: "run-prewalk-production",
      agentDir: makeAndTrackIsolatedAgentDir(),
    });

    const session = await host.spawnRole("worker", { visitIndex: 1 });
    let freshReason: unknown;
    let freshValidations = -1;
    try {
      await session.prompt("ORIGINAL ROLE TASK");
      freshReason = host.sessionTerminalReason(session);
      freshValidations = log
        .records("run-prewalk-production")
        .filter(
          (record) =>
            record.type === "tool_execution_started" && record.tool_name === "prewalk_validation",
        ).length;
    } finally {
      await session.dispose();
    }
    expect(freshReason).toBe(reason);
    const recoveredHost = new ProductionHost({
      modelRegistry: registry,
      cwd,
      log,
      loadedManifest: loaded,
      runId: "run-prewalk-production",
      agentDir: makeAndTrackIsolatedAgentDir(),
    });
    const recovered = await recoveredHost.spawnRole("worker", {
      visitIndex: 2,
      executionVisitIndex: 2,
    });
    let resumedReason: unknown;
    let totalValidations = -1;
    try {
      await recovered.prompt("resume failed executor");
      resumedReason = recoveredHost.sessionTerminalReason(recovered);
      totalValidations = log
        .records("run-prewalk-production")
        .filter(
          (record) =>
            record.type === "tool_execution_started" && record.tool_name === "prewalk_validation",
        ).length;
    } finally {
      await recovered.dispose();
    }
    expect(resumedReason).toBe(reason);
    expect({ fresh: freshValidations, resumed: totalValidations - freshValidations }).toEqual({
      fresh: 0,
      resumed: 0,
    });
  });
});
