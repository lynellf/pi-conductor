import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { makeStubModel, makeStubStreamFunction } from "../../src/host/stub-provider.js";
import { ProductionHost, startRun } from "../../src/index.js";
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

function messages(context: unknown): readonly Record<string, unknown>[] {
  if (typeof context !== "object" || context === null || !("messages" in context)) return [];
  const value = context.messages;
  return Array.isArray(value) ? (value as readonly Record<string, unknown>[]) : [];
}

function text(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : null;
  const part = content.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "type" in candidate &&
      candidate.type === "text" &&
      "text" in candidate,
  );
  return typeof part === "object" &&
    part !== null &&
    "text" in part &&
    typeof part.text === "string"
    ? part.text
    : null;
}

function toolTarget(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "toolCall" &&
      "name" in part &&
      part.name === "handoff" &&
      "arguments" in part &&
      typeof part.arguments === "object" &&
      part.arguments !== null &&
      "target_role" in part.arguments &&
      typeof part.arguments.target_role === "string"
    ) {
      return part.arguments.target_role;
    }
  }
  return null;
}

function registry(requests: unknown[]): ModelRegistry {
  const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const base = makeStubModel();
  modelRegistry.registerProvider("stub", {
    api: "anthropic-messages",
    apiKey: "non-live-stub-key",
    baseUrl: base.baseUrl,
    streamSimple: makeStubStreamFunction({
      onRequest: (context) => requests.push(context),
      steps: [
        { kind: "emit_handoff", target_role: "planner" },
        { kind: "emit_handoff", target_role: "orchestrator" },
        { kind: "emit_handoff", target_role: "implementer" },
        { kind: "emit_handoff", target_role: "orchestrator" },
        { kind: "emit_end" },
      ],
    }),
    models: ["orchestrator", "planner", "implementer"].map((id) => ({
      ...base,
      id,
      name: id,
    })),
  });
  return modelRegistry;
}

describe("Issue #63 premature-ending chain", () => {
  let workdir: string;

  afterEach(async () => rm(workdir, { recursive: true, force: true }));

  it("the implementer inherits terminal planner text and the intervening orchestrator turn", async () => {
    workdir = await mkdtemp(join(tmpdir(), "trajectory-premature-ending-"));
    const runs = join(workdir, "runs");
    const manifestPath = join(workdir, ".pi", "conductor.yaml");
    await mkdir(join(workdir, ".pi", "roles"), { recursive: true });
    await writeFile(manifestPath, MANIFEST, "utf8");
    await Promise.all(
      ["orchestrator", "planner", "implementer"].map((role) =>
        writeFile(join(workdir, ".pi", "roles", `${role}.md`), role, "utf8"),
      ),
    );
    const requests: unknown[] = [];
    const handle = await startRun(manifestPath, {
      goal: "reproduce premature ending",
      baseDir: runs,
      hostFactory: ({ runId, log, loadedManifest }) =>
        new ProductionHost({
          modelRegistry: registry(requests),
          cwd: workdir,
          log,
          loadedManifest,
          runId,
          agentDir: makeAndTrackIsolatedAgentDir(),
        }),
    });

    expect((await handle.completion()).exitReason).toBe("done");
    const implementerRequest = requests[3];
    if (implementerRequest === undefined) throw new Error("missing implementer request");
    const inherited = messages(implementerRequest);

    expect(
      inherited.some(
        (message) =>
          message.role === "toolResult" &&
          text(message) ===
            "emission recorded: handoff → orchestrator. Do not call further tools; the loop will end this session.",
      ),
    ).toBe(true);
    expect(
      inherited.some(
        (message) => message.role === "assistant" && toolTarget(message) === "implementer",
      ),
    ).toBe(true);
    expect(
      inherited.some(
        (message) =>
          message.role === "toolResult" &&
          text(message) ===
            "emission recorded: handoff → implementer. Do not call further tools; the loop will end this session.",
      ),
    ).toBe(true);
  });
});
