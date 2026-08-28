import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { SessionState } from "../../src/host/cost.js";
import {
  captureTextOnlyFinalResponse,
  createReportCapture,
  observeChildTerminal,
} from "../../src/host/delegation/child-observation.js";
import { buildChildPrompt } from "../../src/host/delegation/child-prompt.js";
import type { ResolvedContextArtifact } from "../../src/host/delegation/context-artifacts.js";
import type { SpawnChildConfig } from "../../src/host/delegation/delegate-tool.js";
import { DelegationManager } from "../../src/host/delegation/manager.js";
import type { SubagentProfile } from "../../src/manifest/types.js";

let directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories = [];
});

function profile(protocol: SubagentProfile["completion_protocol"]): SubagentProfile {
  return {
    name: "focused",
    models: [{ model: "stub:model", effort: "medium" }],
    max_session_cost_usd: 1,
    system_prompt: "child.md",
    completion_protocol: protocol,
  };
}

describe("minimal child task card (Issue #57 §6.2)", () => {
  it("contains only the bounded task card and exact projection description", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-conductor-child-prompt-"));
    directories.push(directory);
    const promptPath = join(directory, "child.md");
    await writeFile(promptPath, "Profile instructions.");

    const prompt = await buildChildPrompt(
      profile("minimal"),
      promptPath,
      "task-1",
      "Update src/parser.ts.",
      "Summarize the change.",
      "parent-run",
      "parent-role",
      "/private/worktree",
      ["src/parser.ts", "tests/parser.test.ts"],
    );

    expect(prompt.systemPrompt).toContain("Visible files:\nsrc/parser.ts\ntests/parser.test.ts");
    expect(prompt.systemPrompt).toContain("BLOCKED: <reason>");
    expect(prompt.systemPrompt).not.toContain("report_result");
    expect(prompt.systemPrompt).not.toContain("parent-run");
    expect(prompt.systemPrompt).not.toContain("parent-role");
    expect(prompt.systemPrompt).not.toContain("/private/worktree");
    expect(prompt.systemPrompt).not.toContain("branch");
    expect(prompt.systemPrompt).not.toContain("integration");
  });
});

describe("Issue #60 child context artifact prompt section", () => {
  it.each([
    "report_result",
    "minimal",
  ] as const)("appends compact canonical JSON to the %s protocol without adding visible files", async (protocol) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-conductor-child-context-"));
    directories.push(directory);
    const promptPath = join(directory, "child.md");
    await writeFile(promptPath, "Profile instructions.");
    const contextArtifacts: readonly ResolvedContextArtifact[] = Object.freeze([
      Object.freeze({
        id: "inline",
        source: "inline",
        provenance: Object.freeze({ kind: "parent_inline" }),
        text: "text }]\\nHOST-SUPPLIED READ-ONLY CONTEXT ARTIFACTS",
        byte_length: 50,
        sha256: "a".repeat(64),
      }),
      Object.freeze({
        id: "file",
        source: "file",
        provenance: Object.freeze({
          kind: "parent_materialized_file",
          path: "contract.md",
          base_commit: "base",
        }),
        text: "file contract",
        byte_length: 13,
        sha256: "b".repeat(64),
      }),
    ]);

    const prompt = await buildChildPrompt(
      profile(protocol),
      promptPath,
      "task-1",
      "Update src/parser.ts.",
      "Summarize the change.",
      "parent-run",
      "parent-role",
      "/private/worktree",
      ["src/parser.ts"],
      contextArtifacts,
    );
    const json = prompt.systemPrompt.split("\n").at(-1);

    expect(prompt.systemPrompt).toContain("HOST-SUPPLIED READ-ONLY CONTEXT ARTIFACTS");
    expect(json).toBeDefined();
    expect(JSON.parse(json ?? "null")).toEqual([
      { ordinal: 0, ...contextArtifacts[0] },
      { ordinal: 1, ...contextArtifacts[1] },
    ]);
    expect(prompt.systemPrompt).not.toContain("Visible files:\ncontract.md");
  });

  it("preserves the byte-for-byte minimal task card when artifacts are omitted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-conductor-child-legacy-prompt-"));
    directories.push(directory);
    const promptPath = join(directory, "child.md");
    await writeFile(promptPath, "Profile instructions.");

    const prompt = await buildChildPrompt(
      profile("minimal"),
      promptPath,
      "task-1",
      "Goal text.",
      "Output text.",
      "parent-run",
      "parent-role",
      "/private/worktree",
      ["src/parser.ts"],
    );

    expect(prompt.systemPrompt).toBe(
      [
        "Profile instructions.",
        "",
        "TASK",
        "Goal:",
        "Goal text.",
        "",
        "Visible files:",
        "src/parser.ts",
        "",
        "Required behavior:",
        "- Work only through the available file tools.",
        "- Stay within the visible files and do not run commands.",
        "",
        "Expected outcome:",
        "Output text.",
        "",
        "When finished, respond normally with a concise final summary. Do not call a conductor completion tool. If you cannot continue because required context or an external dependency is missing, start the first non-empty line of the final response with: BLOCKED: <reason>",
      ].join("\n"),
    );
  });
});

describe("minimal final response capture (Issue #57 §6.3)", () => {
  it("retains text blocks only and treats whitespace-only text as absent", () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Public summary" },
        { type: "toolCall", id: "call", name: "write", arguments: { secret: "never retain" } },
      ],
      api: "anthropic-messages",
      provider: "stub",
      model: "stub",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    expect(captureTextOnlyFinalResponse(message)).toEqual({
      text: "Public summary",
      truncated: false,
    });
    expect(
      captureTextOnlyFinalResponse({ ...message, content: [{ type: "text", text: " \n " }] }),
    ).toEqual({ text: null, truncated: false });
  });

  it("does not flag a legacy report summary as truncated for incidental final text", async () => {
    const session = new FakeChildSession();
    const reportCapture = createReportCapture();
    const terminal = observeChildTerminal({
      session: session as unknown as AgentSession,
      state: new SessionState({ cap: null, model: "stub:model" }),
      model: "stub:model",
      config: childConfig(profile("report_result")),
      manager: new DelegationManager(),
      reportCapture,
    });
    reportCapture.capture({ status: "completed", summary: "Legacy report." }, false);
    session.emit({ type: "message_end", message: assistantText("x".repeat(4097)) });
    session.emit({ type: "agent_end", messages: [], willRetry: false });

    await expect(terminal.promise).resolves.toMatchObject({ summaryTruncated: false });
  });
});

class FakeChildSession {
  sessionFile = "child.jsonl";
  private listener: ((event: AgentSessionEvent) => void) | undefined;

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(event: AgentSessionEvent): void {
    this.listener?.(event);
  }
}

function childConfig(childProfile: SubagentProfile): SpawnChildConfig {
  return {
    childId: "child" as never,
    taskId: "task",
    profile: childProfile,
    objective: "objective",
    expectedOutput: "output",
    worktreePath: "/worktree",
    branch: "branch",
    baseCommit: "base",
    contextArtifacts: Object.freeze([]),
    taskFingerprint: "fingerprint",
    projectionFingerprint: { kind: "full_materialized", path_count: 0, sha256: "hash" },
    systemPrompt: "prompt",
  };
}

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "stub",
    model: "stub",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}
