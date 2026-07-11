/**
 * Issue #14 — bounded predecessor-session context.
 *
 * The recipient must be able to opt into a bounded read of exactly the
 * host-selected predecessor session, without receiving a transcript in its
 * initial prompt and without choosing an arbitrary session path.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { createHandoffContextTool } from "../../src/host/index.js";

type ExecuteFn = (
  this: void,
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: unknown,
) => Promise<{
  content: readonly { type: string; text: string }[];
  details: unknown;
  terminate?: boolean;
}>;

function invoke(tool: { execute: unknown }, params: unknown) {
  const execute = tool.execute as unknown as ExecuteFn;
  return execute.call(undefined, "test-call-id", params, undefined, undefined, undefined);
}

describe("createHandoffContextTool", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("reads the host-selected predecessor and bounds the returned context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-conductor-handoff-context-"));
    tempDirs.push(cwd);
    const sessionDir = join(cwd, "sessions");
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendMessage({
      role: "user",
      content: `predecessor verdict: use the approved plan\n${"x".repeat(20_000)}`,
      timestamp: Date.now(),
    });
    // pi flushes a newly-created file once an assistant message arrives;
    // include one so the test exercises the same persisted JSONL surface as
    // a completed role session.
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "handoff recorded" }],
      api: "anthropic-messages",
      provider: "stub",
      model: "stub-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const sourceSessionFile = manager.getSessionFile();
    if (sourceSessionFile === undefined) throw new Error("expected a persisted source session");

    const tool = createHandoffContextTool({
      run_id: "run-14",
      source_role: "planner",
      source_session_file: sourceSessionFile,
    });
    const result = await invoke(tool, {});
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("predecessor verdict: use the approved plan");
    expect(text).toContain("source_role: planner");
    expect(text.length).toBeLessThan(13_000);
    expect(result.details).toMatchObject({ status: "available", truncated: true });
    expect(result.terminate).toBe(false);
  });

  it("has no path parameter and reports an unreadable predecessor explicitly", async () => {
    const tool = createHandoffContextTool({
      run_id: "run-14",
      source_role: "planner",
      source_session_file: "/does/not/exist.jsonl",
    });

    expect(Value.Check(tool.parameters, {})).toBe(true);
    expect(Value.Check(tool.parameters, { source_session_file: "/override.jsonl" })).toBe(false);

    const result = await invoke(tool, {});
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("handoff context unavailable");
    expect(text).toContain("No readable source session exists");
    expect(result.details).toMatchObject({ status: "unavailable" });
  });
});
