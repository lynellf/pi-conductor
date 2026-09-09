import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RpcContextRetentionHost } from "../../../src/host/rpc/context-retention-bridge.js";

type Frame = {
  readonly type?: string;
  readonly id?: string;
  readonly success?: boolean;
  readonly data?: Record<string, unknown>;
};

function send(
  child: ReturnType<typeof spawn>,
  id: string,
  command: Record<string, unknown>,
): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout;
    const stdin = child.stdin;
    if (stdout === null || stdin === null) {
      reject(new Error("child stdio is unavailable"));
      return;
    }
    let pending = "";
    const onData = (chunk: Buffer): void => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const frame = JSON.parse(line) as Frame & { id?: string };
          if (frame.type === "response" && frame.id === id) {
            stdout.off("data", onData);
            resolve(frame);
          }
        } catch {
          // Ignore diagnostics emitted before RPC frames.
        }
      }
    };
    stdout.on("data", onData);
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${id}`)), 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`child exited ${code ?? signal}`));
    });
    stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  });
}

describe("compiled context child bootstrap", () => {
  it.each([
    { label: "explicit model", explicitModel: true },
    { label: "current settings default", explicitModel: false },
  ])("opens the configured child with $label", async ({ explicitModel }) => {
    const root = await mkdtemp(join(tmpdir(), "context-child-bootstrap-"));
    const sessionDir = join(root, "sessions");
    const agentDir = join(root, "agent");
    const bridgeDir = join(root, "bridge");
    const configPath = join(root, "config.json");
    const fixture = fileURLToPath(new URL("./fixtures/context-child-provider.ts", import.meta.url));
    const machineTools = join(root, "machine-tools.json");
    if (!explicitModel) {
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "context-child", defaultModel: "context-child-model" }),
        { flag: "w" },
      );
    }
    await writeFile(
      machineTools,
      JSON.stringify({ workspaceRoot: root, mounts: [], declaredToolNames: ["end"] }),
    );
    await writeFile(
      configPath,
      JSON.stringify({
        cwd: root,
        agentDir,
        sessionDir,
        bridgeDirectory: bridgeDir,
        ...(explicitModel ? { model: "context-child:context-child-model" } : {}),
        effort: "off",
        machineToolsConfigPath: machineTools,
        extensionPath: fixture,
        pinnedCompaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      }),
    );
    const events: Record<string, unknown>[] = [];
    const host = await RpcContextRetentionHost.create(bridgeDir, {
      start: async () => undefined,
      outcome: async (payload) => {
        events.push({ kind: "outcome", ...payload });
      },
      settled: async (payload) => {
        events.push({ kind: "settled", ...payload });
      },
    });
    const child = spawn(process.execPath, ["dist/host/rpc/context-child-entry.js"], {
      cwd: process.cwd(),
      env: { ...process.env, PI_CONDUCTOR_CONTEXT_CHILD_CONFIG: configPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const state = await send(child, "state", { type: "get_state" });
      expect(state.success).toBe(true);
      expect(state.data?.model).toMatchObject({ id: "context-child-model" });
      const sessionId = state.data?.sessionId;
      expect(typeof sessionId).toBe("string");
      const prompt = await send(child, "prompt", { type: "prompt", message: "finish" });
      expect(prompt.success).toBe(true);
      for (
        let attempt = 0;
        attempt < 50 && !events.some((event) => event.kind === "settled");
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(events.some((event) => event.kind === "settled")).toBe(true);
      const settled = events.find((event) => event.kind === "settled");
      expect(settled?.conversationId).toBe(sessionId);
      expect(settled?.sessionId).toBe(sessionId);
      expect(typeof settled?.sessionFile).toBe("string");
      expect(typeof settled?.leafId).toBe("string");
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
