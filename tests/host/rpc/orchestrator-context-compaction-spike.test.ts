import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cliPath = fileURLToPath(
  new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL("./fixtures/orchestrator-context-compaction.ts", import.meta.url),
);

type RpcResponse = {
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
};

function send(
  child: ChildProcessWithoutNullStreams,
  value: Record<string, unknown>,
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const id = String(value.id);
    let pending = "";
    const onData = (chunk: Buffer): void => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          typeof message === "object" &&
          message !== null &&
          (message as { type?: unknown }).type === "response" &&
          (message as { id?: unknown }).id === id
        ) {
          cleanup();
          resolve(message as RpcResponse);
          return;
        }
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`RPC child exited (${code ?? signal})`));
    };
    const cleanup = (): void => {
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdin.write(`${JSON.stringify(value)}\n`);
  });
}

async function waitForEvidence(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      const line = lines.at(-1);
      if (line !== undefined) return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Child has not emitted the extension evidence yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for RPC extension evidence");
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function startChild(
  root: string,
  evidence: string,
  options: {
    readonly throwHook?: boolean;
    readonly failCompaction?: boolean;
    readonly unknownUsage?: boolean;
    readonly sessionFile?: string;
  } = {},
) {
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "--mode",
      "rpc",
      "--no-builtin-tools",
      "--extension",
      fixturePath,
      "--model",
      "context-spike/context-spike-model",
      "--session-dir",
      join(root, "sessions"),
      ...(options.sessionFile === undefined ? [] : ["--session", options.sessionFile]),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(root, "agent"),
        PI_CONTEXT_SPIKE_EVIDENCE: evidence,
        ...(options.throwHook ? { PI_CONTEXT_SPIKE_THROW: "1" } : {}),
        ...(options.failCompaction ? { PI_CONTEXT_SPIKE_FAIL: "1" } : {}),
        ...(options.unknownUsage ? { PI_CONTEXT_SPIKE_UNKNOWN: "1" } : {}),
      },
    },
  );
  child.setMaxListeners(0);
  await send(child, { id: "state", type: "get_state" });
  return child;
}

async function waitForIdle(child: ChildProcessWithoutNullStreams): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await send(child, { id: `idle-${attempt}`, type: "get_state" });
    if ((response.data as { isStreaming?: boolean } | undefined)?.isStreaming === false) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for RPC child to become idle");
}

function waitForEvent(child: ChildProcessWithoutNullStreams, type: string): Promise<void> {
  return new Promise((resolve) => {
    let pending = "";
    const onData = (chunk: Buffer): void => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          if ((JSON.parse(line) as { type?: unknown }).type === type) {
            child.stdout.off("data", onData);
            resolve();
            return;
          }
        } catch {
          // Ignore non-JSON diagnostics.
        }
      }
    };
    child.stdout.on("data", onData);
  });
}

describe("RPC orchestrator context compaction feasibility spike", () => {
  it("uses the child extension hook and exported compact with metered new usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-context-rpc-spike-"));
    const evidence = join(root, "evidence.jsonl");
    try {
      const child = await startChild(root, evidence);
      try {
        const state = await send(child, { id: "initial-state", type: "get_state" });
        expect((state.data as { sessionFile?: string }).sessionFile).toContain(
          join(root, "sessions"),
        );
        for (let index = 0; index < 3; index += 1) {
          const agentEnd = waitForEvent(child, "agent_end");
          expect(
            (
              await send(child, {
                id: `prompt-${index}`,
                type: "prompt",
                message: `historical turn ${index} ${"x".repeat(50_000)}`,
              })
            ).success,
          ).toBe(true);
          await agentEnd;
          await waitForIdle(child);
        }
        const selectedState = await send(child, { id: "selected-state", type: "get_state" });
        const sessionFile = (selectedState.data as { sessionFile?: string }).sessionFile;
        expect(sessionFile).toBeDefined();
        await stop(child);

        const resumedEvidence = join(root, "resumed-evidence.jsonl");
        let resumed: ChildProcessWithoutNullStreams | undefined;
        try {
          resumed = await startChild(root, resumedEvidence, {
            ...(sessionFile === undefined ? {} : { sessionFile }),
          });
          const resumedState = await send(resumed, { id: "resumed-state", type: "get_state" });
          expect((resumedState.data as { sessionFile?: string }).sessionFile).toBe(sessionFile);
          expect((resumedState.data as { model?: { id?: string } }).model?.id).toBe(
            "context-spike-model",
          );
          const beforeStats = await send(resumed, {
            id: "stats-before",
            type: "get_session_stats",
          });
          const response = await send(resumed, { id: "compact", type: "compact" });
          expect(response.success).toBe(true);
          const afterStats = await send(resumed, { id: "stats-after", type: "get_session_stats" });
          const beforeData = beforeStats.data as {
            cost?: number;
            assistantMessages?: number;
            tokens?: unknown;
          };
          const afterData = afterStats.data as typeof beforeData;
          expect(beforeData.cost).toBeGreaterThan(0);
          expect(beforeData.assistantMessages).toBe(3);
          expect(afterData.cost).toBe(beforeData.cost);
          expect(afterData.assistantMessages).toBe(beforeData.assistantMessages);
          expect(afterData.tokens).toEqual(beforeData.tokens);
          const observed = await waitForEvidence(resumedEvidence);
          expect(observed.kind).toBe("success");
          expect(observed.before).toBeGreaterThan(0);
          expect(observed.usage).toMatchObject({ input: 19, output: 7, totalTokens: 26 });
          expect(observed.messagesToSummarize).toBeGreaterThan(0);
          expect(observed.tokensBefore).toBeGreaterThan(0);
        } finally {
          if (resumed !== undefined) await stop(resumed);
        }
      } finally {
        await stop(child);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("swallows a throwing hook, uses native fallback, and reports the actionable extension error", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-context-rpc-spike-fallback-"));
    const evidence = join(root, "evidence.jsonl");
    try {
      const child = await startChild(root, evidence, { throwHook: true });
      try {
        const output: string[] = [];
        child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
        for (let index = 0; index < 3; index += 1) {
          const agentEnd = waitForEvent(child, "agent_end");
          expect(
            (
              await send(child, {
                id: `fallback-prompt-${index}`,
                type: "prompt",
                message: `historical turn ${index} ${"x".repeat(50_000)}`,
              })
            ).success,
          ).toBe(true);
          await agentEnd;
          await waitForIdle(child);
        }
        const response = await send(child, { id: "compact", type: "compact" });
        expect(response.success).toBe(true);
        const observed = await waitForEvidence(evidence);
        expect(observed.kind).toBe("hook_throw");
        expect(output.join("")).toContain("intentional context hook failure");
      } finally {
        await stop(child);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures failed assistant usage and diagnoses an unknown usage boundary without native fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-context-rpc-spike-failure-"));
    const evidence = join(root, "evidence.jsonl");
    try {
      const child = await startChild(root, evidence, { failCompaction: true });
      try {
        for (let index = 0; index < 3; index += 1) {
          const agentEnd = waitForEvent(child, "agent_end");
          await send(child, {
            id: `failure-prompt-${index}`,
            type: "prompt",
            message: `historical turn ${index} ${"x".repeat(50_000)}`,
          });
          await agentEnd;
          await waitForIdle(child);
        }
        const response = await send(child, { id: "failed-compact", type: "compact" });
        expect(response.success).toBe(false);
        const observed = await waitForEvidence(evidence);
        expect(observed.diagnostic).toBe("failed-after-26-tokens");
        expect(observed.nativeProviderCalls).toBe(3);
      } finally {
        await stop(child);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const unknownRoot = await mkdtemp(join(tmpdir(), "pi-context-rpc-spike-unknown-"));
    const unknownEvidence = join(unknownRoot, "evidence.jsonl");
    try {
      const child = await startChild(unknownRoot, unknownEvidence, {
        failCompaction: true,
        unknownUsage: true,
      });
      try {
        for (let index = 0; index < 3; index += 1) {
          const agentEnd = waitForEvent(child, "agent_end");
          await send(child, {
            id: `unknown-prompt-${index}`,
            type: "prompt",
            message: `historical turn ${index} ${"x".repeat(50_000)}`,
          });
          await agentEnd;
          await waitForIdle(child);
        }
        const response = await send(child, { id: "unknown-compact", type: "compact" });
        expect(response.success).toBe(false);
        const observed = await waitForEvidence(unknownEvidence);
        expect(observed.diagnostic).toBe("unknown-usage");
      } finally {
        await stop(child);
      }
    } finally {
      await rm(unknownRoot, { recursive: true, force: true });
    }
  });
});
