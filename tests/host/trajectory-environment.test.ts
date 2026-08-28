import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RoleSession } from "../../src/host/host.js";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import { FileRecordLog, loadManifest, ProductionHost, startRun } from "../../src/index.js";

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

function autoCompactionEnabled(session: RoleSession): boolean {
  return (
    session as RoleSession & { readonly isAutoCompactionEnabled: () => boolean }
  ).isAutoCompactionEnabled();
}

function registryWithTrajectoryScript(requests: unknown[]): ModelRegistry {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const base = makeStubModel();
  registry.registerProvider("stub", {
    api: "anthropic-messages",
    apiKey: "non-live-stub-key",
    baseUrl: base.baseUrl,
    streamSimple: makeStubStreamFunction({
      steps: [
        { kind: "emit_handoff", target_role: "planner" },
        { kind: "emit_handoff", target_role: "orchestrator" },
        { kind: "emit_handoff", target_role: "implementer" },
        { kind: "emit_handoff", target_role: "orchestrator" },
        { kind: "emit_end" },
      ],
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

  it("disables automatic compaction before an outgoing trajectory source can prompt", async () => {
    const loaded = await loadManifest(manifestPath);
    const host = new ProductionHost({
      modelRegistry: registryWithTrajectoryScript([]),
      cwd: workdir,
      log: new FileRecordLog({ baseDir: runs }),
      loadedManifest: loaded,
      runId: "auto-compaction-test",
    });
    const session = await host.spawnRole("planner");
    expect(autoCompactionEnabled(session)).toBe(false);
    await session.dispose();
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
        }),
    });

    const completion = await handle.completion();
    expect(completion.exitReason).toBe("done");

    const records = new FileRecordLog({ baseDir: runs }).records(handle.runId);
    const selected = records.filter((record) => record.type === "handoff_transport_selected");
    expect(selected).toHaveLength(2);
    const starts = records.filter((record) => record.type === "session_started");
    const planner = starts.find((record) => record.role === "planner");
    const trajectoryOrchestrator = starts.filter((record) => record.role === "orchestrator")[1];
    const implementer = starts.find((record) => record.role === "implementer");
    const freshOrchestrator = starts.filter((record) => record.role === "orchestrator")[2];
    expect(planner?.session_file).toBe(trajectoryOrchestrator?.session_file);
    expect(planner?.session_file).toBe(implementer?.session_file);
    expect(implementer?.session_file).not.toBe(freshOrchestrator?.session_file);
    expect(requests.length).toBe(5);
    expect(requestPrompt(requests[2])).toBe("ORCHESTRATOR_PROMPT");
    expect(requestPrompt(requests[3])).toBe("IMPLEMENTER_PROMPT");
    expect(requestMessages(requests[2]).map((message) => message.role)).toContain("toolResult");
    expect(requestMessages(requests[3]).map((message) => message.role)).toContain("toolResult");
  });
});
