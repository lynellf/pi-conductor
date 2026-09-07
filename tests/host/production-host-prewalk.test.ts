import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StreamFunction } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifestFromString } from "../../src/host/manifest.js";
import { ProductionHost } from "../../src/host/production-host.js";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
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

describe("ProductionHost Prewalk integration", () => {
  it.each([
    { transfer: "native", accepted: true, guideMaxTurns: 1 },
    { transfer: "native", accepted: true, guideMaxTurns: 4 },
    { transfer: "projection", accepted: true, guideMaxTurns: 4 },
    { transfer: "native", accepted: false, guideMaxTurns: 4 },
    { transfer: "projection", accepted: false, guideMaxTurns: 4 },
  ] as const)("runs and recovers $transfer seed (durably accepted=$accepted, guide cap=$guideMaxTurns)", async ({
    transfer,
    accepted,
    guideMaxTurns,
  }) => {
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
            {
              kind: "emit_handoff",
              target_role: "orchestrator",
              reason: "executor verified prior work",
            },
            { kind: "emit_handoff", target_role: "orchestrator", reason: "recovered executor" },
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
    const logicalId = session.sessionId;
    const guideConversationId = session.conversationId;
    if (guideMaxTurns === 1) {
      await expect(session.prompt("ORIGINAL ROLE TASK")).rejects.toMatchObject({
        code: "prewalk_guide_turn_cap_exceeded",
      });
      expect(requests).toHaveLength(1);
      expect(host.sessionTerminalReason(session)).toBe("prewalk_guide_turn_cap_exceeded");
      expect(
        log
          .records("run-prewalk-production")
          .find((record) => record.type === "prewalk_switch_failed"),
      ).toMatchObject({
        code: "prewalk_guide_turn_cap_exceeded",
        git_checkpoint: { exemplar_sha: expect.any(String) },
      });
      await session.dispose();
      return;
    }
    await session.prompt("ORIGINAL ROLE TASK");

    expect(session.sessionId).toBe(logicalId);
    expect(session.conversationId === guideConversationId).toBe(transfer === "native");
    expect(session.readCaptureBuffer()).toHaveLength(1);
    expect(log.records("run-prewalk-production").map((record) => record.type)).toEqual(
      expect.arrayContaining([
        "prewalk_switch_selected",
        "prewalk_executor_seed_delivered",
        "prewalk_validation_run",
        "prewalk_phase_usage",
      ]),
    );
    expect(requests).toHaveLength(4);
    const selected = log
      .records("run-prewalk-production")
      .find((record) => record.type === "prewalk_switch_selected");
    expect(selected).toMatchObject({ transfer_mode: transfer, role_session_id: logicalId });
    if (transfer === "projection" && selected?.type === "prewalk_switch_selected") {
      const projection = selected.executor.continuation_seed;
      expect(projection.match(/\[guide-tool-result /g)).toHaveLength(1);
      expect(projection).toContain('referenced_paths=["README.md"]');
      expect(projection).toContain("UNCHANGED GUIDE READ");
    }
    expect(
      log
        .records("run-prewalk-production")
        .find((record) => record.type === "prewalk_validation_run"),
    ).toMatchObject({ false_done_count: 0, false_done_rate: 0 });
    expect(
      log.records("run-prewalk-production").find((record) => record.type === "prewalk_phase_usage"),
    ).toMatchObject({ phase: "executor", model: "stub:executor" });
    const conversation = session.conversationId;
    const file = session.sessionFile;
    await session.dispose();
    if (selected?.type !== "prewalk_switch_selected" || file === undefined)
      throw new Error("expected persisted selection");
    if (!accepted) {
      const intent = log
        .records("run-prewalk-production")
        .find((record) => record.type === "prewalk_executor_seed_intent");
      if (intent?.type !== "prewalk_executor_seed_intent") throw new Error("expected intent");
      if (transfer === "projection") await rm(file);
      else {
        const lines = (await readFile(file, "utf8")).trim().split("\n");
        const boundary = lines.findIndex(
          (line) => (JSON.parse(line) as { id: string }).id === intent.after_entry_id,
        );
        if (boundary < 0) throw new Error("expected durable guide boundary");
        await writeFile(file, `${lines.slice(0, boundary + 1).join("\n")}\n`);
      }
    }
    const recoveryLog = new InMemoryRecordLog();
    for (const record of log.records("run-prewalk-production")) {
      if (record.type !== "prewalk_executor_seed_delivered") recoveryLog.append(record);
    }
    const recoveredHost = new ProductionHost({
      modelRegistry: registry,
      cwd,
      log: recoveryLog,
      loadedManifest: loaded,
      runId: "run-prewalk-production",
      agentDir: makeAndTrackIsolatedAgentDir(),
    });
    const recovered = await recoveredHost.spawnRole("worker", { visitIndex: 1 });
    await recovered.prompt("resume after the seed marker was lost");
    expect(recovered.conversationId).toBe(conversation);
    const users = SessionManager.open(file)
      .getBranch()
      .filter((entry) => entry.type === "message" && entry.message.role === "user");
    const exactSeed = users.filter(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        JSON.stringify(entry.message.content) ===
          JSON.stringify([{ type: "text", text: selected.executor.continuation_seed }]),
    );
    expect(exactSeed).toHaveLength(1);
    expect(
      recoveryLog
        .records("run-prewalk-production")
        .filter((record) => record.type === "prewalk_executor_seed_delivered"),
    ).toHaveLength(1);
    await recovered.dispose();
  });
});
