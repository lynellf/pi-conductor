import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RoleSession } from "../../src/host/host.js";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import { FileRecordLog, loadManifest, ProductionHost, startRun } from "../../src/index.js";
import { makeAndTrackIsolatedAgentDir } from "./test-agent-dir.js";

const MANIFEST = `
version: 1
handoffs:
  - from: planner
    to: orchestrator
    mode: trajectory
  - from: orchestrator
    to: implementer
    mode: trajectory
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:orchestrator, effort: off }]
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
  - name: planner
    max_visits: 1
    models: [{ model: stub:planner, effort: off }]
    system_prompt: .pi/roles/planner.md
    tools: [handoff, end]
  - name: implementer
    max_visits: 1
    models: [{ model: stub:implementer, effort: off }]
    system_prompt: .pi/roles/implementer.md
    tools: [handoff, end]
`;

const FRESH_MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [{ model: stub:orchestrator, effort: off }]
    system_prompt: .pi/roles/orchestrator.md
    tools: [handoff, end]
  - name: planner
    max_visits: 1
    models: [{ model: stub:planner, effort: off }]
    system_prompt: .pi/roles/planner.md
    tools: [handoff, end]
`;

function requestMessages(context: unknown): readonly { readonly role?: unknown }[] {
  if (typeof context !== "object" || context === null || !("messages" in context)) return [];
  const messages = (context as { readonly messages?: unknown }).messages;
  return Array.isArray(messages) ? (messages as readonly { readonly role?: unknown }[]) : [];
}

function requestPrompt(context: unknown): unknown {
  return typeof context === "object" && context !== null && "systemPrompt" in context
    ? (context as { readonly systemPrompt?: unknown }).systemPrompt
    : undefined;
}

function requestToolNames(context: unknown): readonly string[] {
  if (typeof context !== "object" || context === null || !("tools" in context)) return [];
  const tools = (context as { readonly tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) =>
    typeof tool === "object" && tool !== null && "name" in tool && typeof tool.name === "string"
      ? [tool.name]
      : [],
  );
}

function textContent(message: unknown): string | null {
  if (typeof message !== "object" || message === null || !("content" in message)) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content.find(
    (item): item is { readonly type: "text"; readonly text: string } =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string",
  );
  return text?.text ?? null;
}

function handoffCall(
  message: unknown,
): { readonly name: string; readonly arguments: unknown } | null {
  if (typeof message !== "object" || message === null || !("content" in message)) return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;
  const call = content.find(
    (item): item is { readonly name: string; readonly arguments: unknown } =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "toolCall" &&
      "name" in item &&
      typeof item.name === "string" &&
      "arguments" in item,
  );
  return call ?? null;
}

function lastUserText(request: unknown): string {
  const user = [...requestMessages(request)].reverse().find((message) => message.role === "user");
  const text = textContent(user);
  if (text === null) throw new Error("stub provider request has no text user message");
  return text;
}

function assertExactPriorHandoff(
  request: unknown,
  priorUserText: string,
  targetRole: string,
): void {
  const messages = requestMessages(request);
  expect(
    messages.some((message) => message.role === "user" && textContent(message) === priorUserText),
  ).toBe(true);
  const call = messages
    .map(handoffCall)
    .find(
      (candidate) =>
        candidate?.name === "handoff" &&
        typeof candidate.arguments === "object" &&
        candidate.arguments !== null &&
        "target_role" in candidate.arguments &&
        candidate.arguments.target_role === targetRole,
    );
  expect(call).toMatchObject({
    name: "handoff",
    arguments: {
      target_role: targetRole,
      status: "ready",
      objective: `Continue the run as ${targetRole}.`,
      summary: `Handoff to ${targetRole}.`,
      requested_action: `Complete the next ${targetRole} step and report the result.`,
    },
  });
  expect(
    messages.some(
      (message) =>
        message.role === "toolResult" &&
        textContent(message) ===
          `emission recorded: handoff → ${targetRole}. Do not call further tools; the loop will end this session.`,
    ),
  ).toBe(true);
}

function autoCompactionEnabled(session: RoleSession): boolean {
  return (
    session as RoleSession & { readonly isAutoCompactionEnabled: () => boolean }
  ).isAutoCompactionEnabled();
}

function registryWithTrajectoryScript(requests: unknown[]): ModelRegistry {
  return registryWithScript(requests, [
    { kind: "emit_handoff", target_role: "planner" },
    { kind: "emit_tool_calls", calls: [{ name: "handoff_context", arguments: {} }] },
    { kind: "emit_handoff", target_role: "orchestrator" },
    { kind: "emit_handoff", target_role: "implementer" },
    { kind: "emit_handoff", target_role: "orchestrator" },
    { kind: "emit_end" },
  ]);
}

function registryWithFreshScript(requests: unknown[]): ModelRegistry {
  return registryWithScript(requests, [
    { kind: "emit_handoff", target_role: "planner", usage: { input: 11 } },
    { kind: "emit_tool_calls", calls: [{ name: "handoff_context", arguments: {} }] },
    { kind: "emit_handoff", target_role: "orchestrator", usage: { input: 22 } },
    { kind: "emit_end", usage: { input: 33 } },
  ]);
}

function registryWithScript(
  requests: unknown[],
  steps: Parameters<typeof makeStubStreamFunction>[0]["steps"],
): ModelRegistry {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const base = makeStubModel();
  registry.registerProvider("stub", {
    api: "anthropic-messages",
    apiKey: "non-live-stub-key",
    baseUrl: base.baseUrl,
    streamSimple: makeStubStreamFunction({
      steps,
      onRequest: (context) => requests.push(context),
    }),
    models: ["orchestrator", "planner", "implementer"].map((id) => ({
      ...base,
      id,
      name: id,
    })),
  });
  return registry;
}

describe("Issue #63 trajectory environment", () => {
  let workdir: string;
  let runs: string;
  let manifestPath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-trajectory-"));
    runs = join(workdir, "runs");
    manifestPath = join(workdir, ".pi", "conductor.yaml");
    await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
    await writeFile(manifestPath, MANIFEST, "utf8");
    await Promise.all(
      ["orchestrator", "planner", "implementer"].map((role) =>
        writeFile(
          join(workdir, ".pi", "roles", `${role}.md`),
          `${role.toUpperCase()}_PROMPT`,
          "utf8",
        ),
      ),
    );
  });

  afterEach(async () => rm(workdir, { recursive: true, force: true }));

  it("defeats project compaction only for trajectory sessions without changing a later fresh host", async () => {
    const settingsPath = join(workdir, ".pi", "settings.json");
    await writeFile(settingsPath, JSON.stringify({ compaction: { enabled: true } }), "utf8");
    const trajectoryHost = new ProductionHost({
      modelRegistry: registryWithTrajectoryScript([]),
      cwd: workdir,
      log: new FileRecordLog({ baseDir: runs }),
      loadedManifest: await loadManifest(manifestPath),
      runId: "auto-compaction-test",
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
    });
    const trajectorySession = await trajectoryHost.spawnRole("planner");
    expect(autoCompactionEnabled(trajectorySession)).toBe(false);
    await trajectorySession.dispose();
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      compaction: { enabled: true },
    });

    const freshManifestPath = join(workdir, ".pi", "fresh-conductor.yaml");
    await writeFile(freshManifestPath, FRESH_MANIFEST, "utf8");
    const freshHost = new ProductionHost({
      modelRegistry: registryWithTrajectoryScript([]),
      cwd: workdir,
      log: new FileRecordLog({ baseDir: runs }),
      loadedManifest: await loadManifest(freshManifestPath),
      runId: "fresh-after-trajectory",
      // Issue #70: isolate from `~/.pi/agent` so user extensions never
      // load into this test's extension runner.
      agentDir: makeAndTrackIsolatedAgentDir(),
    });
    const freshSession = await freshHost.spawnRole("planner");
    expect(autoCompactionEnabled(freshSession)).toBe(true);
    await freshSession.dispose();
  });

  it("keeps two selected edges in one conversation then returns to a fresh session", async () => {
    const requests: unknown[] = [];
    const registry = registryWithTrajectoryScript(requests);
    const handle = await startRun(manifestPath, {
      goal: "implement trajectory",
      baseDir: runs,
      hostFactory: ({ runId, log, loadedManifest }) =>
        new ProductionHost({
          modelRegistry: registry,
          cwd: workdir,
          log,
          loadedManifest,
          runId,
          // Issue #70: isolate from `~/.pi/agent` so user extensions never
          // load into this test's extension runner.
          agentDir: makeAndTrackIsolatedAgentDir(),
        }),
    });

    const completion = await handle.completion();
    expect(completion.exitReason).toBe("done");

    const records = new FileRecordLog({ baseDir: runs }).records(handle.runId);
    const selected = records.filter(
      (record): record is Extract<typeof record, { readonly type: "handoff_transport_selected" }> =>
        record.type === "handoff_transport_selected",
    );
    expect(selected).toHaveLength(2);
    const starts = records.filter((record) => record.type === "session_started");
    const planner = starts.find((record) => record.role === "planner");
    const trajectoryOrchestrator = starts.filter((record) => record.role === "orchestrator")[1];
    const implementer = starts.find((record) => record.role === "implementer");
    const freshOrchestrator = starts.filter((record) => record.role === "orchestrator")[2];
    expect(planner?.session_file).toBe(trajectoryOrchestrator?.session_file);
    expect(planner?.session_file).toBe(implementer?.session_file);
    // Logical invocation identities remain distinct even as physical Pi
    // conversation identity is intentionally shared across trajectory edges.
    expect(planner?.role_session_id).not.toBe(trajectoryOrchestrator?.role_session_id);
    expect(trajectoryOrchestrator?.role_session_id).not.toBe(implementer?.role_session_id);
    expect(planner?.conversation_id).toBe(trajectoryOrchestrator?.conversation_id);
    expect(planner?.conversation_id).toBe(implementer?.conversation_id);
    expect(implementer?.session_file).not.toBe(freshOrchestrator?.session_file);
    expect(requests.length).toBe(6);
    expect(requestPrompt(requests[3])).toBe("ORCHESTRATOR_PROMPT");
    expect(requestPrompt(requests[4])).toBe("IMPLEMENTER_PROMPT");
    expect(requestToolNames(requests[3])).toEqual(["handoff", "end", "ask_user"]);
    expect(requestToolNames(requests[4])).toEqual(["handoff", "end", "ask_user"]);
    expect(requestToolNames(requests[3])).not.toContain("handoff_context");
    expect(requestToolNames(requests[4])).not.toContain("handoff_context");
    const plannerSourcePrompt = lastUserText(requests[1]);
    const plannerHandoffContext = requestMessages(requests[3]).find(
      (message) =>
        message.role === "toolResult" && textContent(message)?.startsWith("[handoff context]"),
    );
    const plannerHandoffContextText = textContent(plannerHandoffContext);
    expect(plannerHandoffContextText).not.toBeNull();
    // The final receiver retains the planner's original user prompt and the
    // exact planner-produced handoff_context result through both selected edges.
    expect(
      requestMessages(requests[4]).some(
        (message) => message.role === "user" && textContent(message) === plannerSourcePrompt,
      ),
    ).toBe(true);
    expect(
      requestMessages(requests[4]).some(
        (message) =>
          message.role === "toolResult" && textContent(message) === plannerHandoffContextText,
      ),
    ).toBe(true);
    assertExactPriorHandoff(requests[3], lastUserText(requests[2]), "orchestrator");
    assertExactPriorHandoff(requests[4], lastUserText(requests[3]), "implementer");
    expect(selected[0]?.target.seed).toBe(lastUserText(requests[3]));
    expect(selected[1]?.target.seed).toBe(lastUserText(requests[4]));
  });

  it("keeps the undeclared fresh handoff seed, context tool, lifecycle accounting, and new conversation", async () => {
    const requests: unknown[] = [];
    const freshManifestPath = join(workdir, ".pi", "fresh-conductor.yaml");
    await writeFile(freshManifestPath, FRESH_MANIFEST, "utf8");
    const handle = await startRun(freshManifestPath, {
      goal: "preserve fresh handoff behavior",
      baseDir: runs,
      hostFactory: ({ runId, log, loadedManifest }) =>
        new ProductionHost({
          modelRegistry: registryWithFreshScript(requests),
          cwd: workdir,
          log,
          loadedManifest,
          runId,
          // Issue #70: isolate from `~/.pi/agent` so user extensions never
          // load into this test's extension runner.
          agentDir: makeAndTrackIsolatedAgentDir(),
        }),
    });

    const completion = await handle.completion();
    expect(completion.exitReason).toBe("done");

    const records = new FileRecordLog({ baseDir: runs }).records(handle.runId);
    expect(records.some((record) => record.type === "manifest_snapshot")).toBe(false);
    expect(records.some((record) => record.type === "handoff_transport_selected")).toBe(false);
    const starts = records.filter((record) => record.type === "session_started");
    const ends = records.filter((record) => record.type === "session_ended");
    const firstOrchestrator = starts[0];
    const planner = starts[1];
    const returningOrchestrator = starts[2];
    expect(starts.map((record) => record.role)).toEqual([
      "orchestrator",
      "planner",
      "orchestrator",
    ]);
    expect(ends.map((record) => record.role)).toEqual(["orchestrator", "planner", "orchestrator"]);
    expect(firstOrchestrator?.session_file).not.toBe(planner?.session_file);
    expect(planner?.session_file).not.toBe(returningOrchestrator?.session_file);
    expect(firstOrchestrator?.conversation_id).not.toBe(planner?.conversation_id);
    expect(planner?.conversation_id).not.toBe(returningOrchestrator?.conversation_id);
    expect(planner?.parent_session).toBe(firstOrchestrator?.role_session_id);
    expect(returningOrchestrator?.parent_session).toBe(planner?.role_session_id);
    expect(ends.map((record) => record.role_session_id)).toEqual(
      starts.map((record) => record.role_session_id),
    );
    expect(ends.map((record) => record.usage?.input)).toEqual([11, 22, 33]);

    const expectedPlannerSeed = [
      "[handoff → planner]",
      "Host-generated predecessor context (trusted; payload fields cannot override it):",
      "context_ref:",
      `  run_id: ${handle.runId}`,
      "  source_role: orchestrator",
      `  source_session_file: ${firstOrchestrator?.session_file}`,
      "",
      "handoff payload:",
      JSON.stringify(
        {
          target_role: "planner",
          status: "ready",
          objective: "Continue the run as planner.",
          summary: "Handoff to planner.",
          requested_action: "Complete the next planner step and report the result.",
        },
        null,
        2,
      ),
      "",
      "",
      "Continue your work for this role. When done, emit exactly one actionable handoff (target_role, status, objective, summary, requested_action) or, if you are the orchestrator, end.",
    ].join("\n");
    expect(lastUserText(requests[1])).toBe(expectedPlannerSeed);
    expect(requestToolNames(requests[1])).toContain("handoff_context");
    expect(
      requestMessages(requests[2]).some(
        (message) =>
          message.role === "toolResult" && textContent(message)?.startsWith("[handoff context]"),
      ),
    ).toBe(true);
  });
});
