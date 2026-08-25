import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MACHINE_TOOLS_CONFIG_ENV } from "../../../src/host/rpc/machine-tools-config.js";
import {
  NodeRoleSession,
  RpcAbortTimeoutError,
  RpcChildExitError,
  type RpcChildProcess,
  RpcProtocolError,
  type RpcSpawnOptions,
  resolveMachineToolsExtensionPath,
  resolvePackageLocalPiCli,
} from "../../../src/host/rpc/node-role-session.js";
import { createNodeRoleSession } from "../../../src/host/rpc/node-role-session-factory.js";
import { RunControl } from "../../../src/host/run-control.js";

class FakeWritable extends EventEmitter {
  readonly writes: string[] = [];
  writable = true;
  destroyed = false;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(): void {
    this.writable = false;
  }
}

class FakeReadable extends EventEmitter {
  writeFrame(frame: string): void {
    this.emit("data", Buffer.from(frame));
  }

  writeFragmented(frame: string): void {
    let offset = 0;
    const widths = [1, 4, 2, 7];
    let index = 0;
    while (offset < frame.length) {
      const width = widths[index % widths.length] ?? 1;
      this.writeFrame(frame.slice(offset, offset + width));
      offset += width;
      index += 1;
    }
  }
}

class FakeChild extends EventEmitter implements RpcChildProcess {
  readonly stdin = new FakeWritable();
  private readonly ignoreSigterm: boolean;

  constructor(
    ignoreSigterm = false,
    private readonly ignoreSigkill = false,
  ) {
    super();
    this.ignoreSigterm = ignoreSigterm;
  }
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly killSignals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    if (
      (signal === "SIGKILL" && !this.ignoreSigkill) ||
      (signal !== "SIGKILL" && !this.ignoreSigterm)
    ) {
      queueMicrotask(() => this.exit(null, signal));
    }
    return true;
  }

  command(type: string, occurrence = 0): Record<string, unknown> {
    const commands = this.stdin.writes
      .map((write) => JSON.parse(write) as Record<string, unknown>)
      .filter((command) => command.type === type);
    const command = commands[occurrence];
    if (command === undefined) throw new Error(`missing ${type} command #${occurrence}`);
    return command;
  }

  success(command: Record<string, unknown>, data?: unknown, fragmented = false): void {
    const response = {
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      ...(data === undefined ? {} : { data }),
    };
    this.write(`${JSON.stringify(response)}\r\n`, fragmented);
  }

  failure(command: Record<string, unknown>, error: string): void {
    this.write(
      `${JSON.stringify({
        id: command.id,
        type: "response",
        command: command.type,
        success: false,
        error,
      })}\n`,
      false,
    );
  }

  event(event: Record<string, unknown>, fragmented = false): void {
    this.write(`${JSON.stringify(event)}\r\n`, fragmented);
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  private write(frame: string, fragmented: boolean): void {
    if (fragmented) {
      this.stdout.writeFragmented(frame);
      return;
    }
    this.stdout.writeFrame(frame);
  }
}

const handoffArgs = {
  target_role: "orchestrator",
  status: "ready",
  objective: "review the isolated change",
  summary: "adapter behavior is covered",
  requested_action: "review it",
};

const stats = {
  tokens: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, total: 23 },
  cost: 0.42,
};

async function startSession(
  child: FakeChild,
  stateData: unknown = { sessionId: "rpc-session", sessionFile: "/role-worktree/session.jsonl" },
): Promise<Awaited<ReturnType<typeof createNodeRoleSession>>> {
  let spawnOptions: RpcSpawnOptions | undefined;
  const starting = createNodeRoleSession({
    role: "implementer",
    model: "stub:isolated",
    effort: "medium",
    cwd: "/role-worktree",
    sessionDir: "/host-run/sessions",
    agentDir: "/host-agent",
    systemPrompt: "resolved role prompt",
    machineToolsConfigPath: "/role-worktree/machine-tools.json",
    spawn: (options: RpcSpawnOptions) => {
      spawnOptions = options;
      return child;
    },
  });
  const state = child.command("get_state");
  expect(state.id).toEqual(expect.any(String));
  child.success(state, stateData, true);
  const session = await starting;

  expect(spawnOptions).toMatchObject({
    command: process.execPath,
    args: [
      resolvePackageLocalPiCli(),
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-builtin-tools",
      "--extension",
      resolveMachineToolsExtensionPath(),
      "--model",
      "stub/isolated",
      "--thinking",
      "medium",
      "--system-prompt",
      "resolved role prompt",
      "--session-dir",
      "/host-run/sessions",
    ],
    cwd: "/role-worktree",
    env: expect.objectContaining({
      PI_CODING_AGENT_DIR: "/host-agent",
      [MACHINE_TOOLS_CONFIG_ENV]: "/role-worktree/machine-tools.json",
    }),
  });
  expect(spawnOptions?.args).not.toContain("/role-worktree/machine-tools.json");
  expect(existsSync(resolvePackageLocalPiCli())).toBe(true);
  expect(existsSync(resolveMachineToolsExtensionPath())).toBe(true);
  return session;
}

async function settlePrompt(
  child: FakeChild,
  occurrence: number,
  event: Record<string, unknown>,
): Promise<void> {
  const command = child.command("prompt", occurrence);
  child.success(command, undefined, true);
  child.event(event, true);
  child.event({ type: "agent_end", messages: [], willRetry: false }, true);
  await Promise.resolve();
  child.success(child.command("get_session_stats", occurrence), stats, true);
}

describe("createNodeRoleSession", () => {
  it("derives the existing CLI from Pi's Node-resolved peer package", () => {
    const packageJson = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
    if (packageJson === undefined)
      throw new Error("Pi package was not resolved from this test module");
    const expectedCli = join(dirname(realpathSync(packageJson)), "dist", "cli.js");

    expect(resolvePackageLocalPiCli()).toBe(expectedCli);
    expect(existsSync(resolvePackageLocalPiCli())).toBe(true);
  });

  it("uses LF-only JSONL, maps child identity and usage, and captures handoff/end events", async () => {
    const child = new FakeChild();
    const session = await startSession(child);

    expect(session.sessionId).toBe("rpc-session");
    expect(session.sessionFile).toBe("/role-worktree/session.jsonl");
    for (const write of child.stdin.writes) {
      expect(write.endsWith("\n")).toBe(true);
      expect(write.endsWith("\r\n")).toBe(false);
      expect(JSON.parse(write)).toEqual(expect.any(Object));
    }

    const first = session.prompt("handoff when done");
    expect(child.command("prompt")).toMatchObject({
      id: expect.any(String),
      type: "prompt",
      message: "handoff when done",
    });
    await settlePrompt(child, 0, {
      type: "tool_execution_start",
      toolCallId: "handoff-call",
      toolName: "handoff",
      args: handoffArgs,
    });
    await first;

    expect(session.readCaptureBuffer()).toEqual([{ toolName: "handoff", args: handoffArgs }]);
    expect(Object.isFrozen(session.readCaptureBuffer())).toBe(true);
    expect(session.captureUsage()).toEqual({
      input: 11,
      output: 7,
      cache_read: 3,
      cache_write: 2,
      tokens: 23,
      cost: 0.42,
    });

    session.resetCaptureBuffer();
    const second = session.prompt("end when done");
    await settlePrompt(child, 1, {
      type: "tool_execution_start",
      toolCallId: "end-call",
      toolName: "end",
      args: { reason: "complete" },
    });
    await second;

    expect(session.readCaptureBuffer()).toEqual([
      { toolName: "end", args: { reason: "complete" } },
    ]);
  });

  it("omits model and system-prompt flags when the host selected Pi defaults", async () => {
    const child = new FakeChild();
    let spawnOptions: RpcSpawnOptions | undefined;
    const starting = createNodeRoleSession({
      role: "implementer",
      model: null,
      effort: "medium",
      cwd: "/role-worktree",
      sessionDir: "/host-run/sessions",
      agentDir: "/host-agent",
      systemPrompt: null,
      machineToolsConfigPath: "/host-run/machine-tools.json",
      spawn: (options: RpcSpawnOptions) => {
        spawnOptions = options;
        return child;
      },
    });
    child.success(child.command("get_state"), {
      sessionId: "default-rpc-session",
      sessionFile: "/host-run/sessions/default.jsonl",
    });
    await starting;

    expect(spawnOptions?.args).toEqual(
      expect.arrayContaining(["--thinking", "medium", "--session-dir", "/host-run/sessions"]),
    );
    expect(spawnOptions?.args).not.toEqual(expect.arrayContaining(["--model", "--system-prompt"]));
  });

  it("does not resolve prompt merely because the child accepted the command", async () => {
    const child = new FakeChild();
    const session = await startSession(child);
    const prompt = session.prompt("do the work");
    const command = child.command("prompt");
    child.success(command, undefined, true);

    let settled = false;
    void prompt.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    child.event({ type: "agent_end", messages: [], willRetry: false }, true);
    child.success(child.command("get_session_stats"), stats, true);

    await expect(prompt).resolves.toBeUndefined();
  });

  it("does not settle a terminal-tool turn before preflight, retry completion, and valid stats", async () => {
    const child = new FakeChild();
    const session = await startSession(child);
    const prompt = session.prompt("complete only after the terminal turn actually finishes");

    child.event({
      type: "tool_execution_start",
      toolCallId: "handoff-call",
      toolName: "handoff",
      args: handoffArgs,
    });
    child.event({
      type: "tool_execution_end",
      toolCallId: "handoff-call",
      toolName: "handoff",
      result: {},
      isError: false,
    });
    expect(child.stdin.writes.map((write) => JSON.parse(write).type)).toEqual([
      "get_state",
      "prompt",
    ]);

    child.success(child.command("prompt"));
    child.event({ type: "agent_end", messages: [], willRetry: true });
    await Promise.resolve();
    expect(child.stdin.writes.map((write) => JSON.parse(write).type)).toEqual([
      "get_state",
      "prompt",
    ]);

    child.event({ type: "agent_end", messages: [], willRetry: false });
    child.success(child.command("get_session_stats"), stats);

    await expect(prompt).resolves.toBeUndefined();
  });

  it("rejects initialize when a successful get_state lacks child identity", async () => {
    const child = new FakeChild();

    await expect(startSession(child, { sessionId: "", sessionFile: "" })).rejects.toMatchObject({
      name: "RpcStateError",
    });
  });

  it("rejects an unknown correlated response instead of settling the pending turn", async () => {
    const child = new FakeChild();
    const session = await startSession(child);
    const prompt = session.prompt("do not trust another request response");

    child.stdout.writeFrame(
      `${JSON.stringify({
        id: "not-a-host-generated-id",
        type: "response",
        command: "prompt",
        success: true,
      })}\n`,
    );

    await expect(prompt).rejects.toMatchObject({ name: "RpcProtocolError" });
  });

  it("rejects a command-mismatched response instead of settling the pending turn", async () => {
    const child = new FakeChild();
    const session = await startSession(child);
    const prompt = session.prompt("do not trust a mismatched command");
    const command = child.command("prompt");

    child.stdout.writeFrame(
      `${JSON.stringify({
        id: command.id,
        type: "response",
        command: "abort",
        success: true,
      })}\n`,
    );

    await expect(prompt).rejects.toMatchObject({ name: "RpcProtocolError" });
  });

  it("rejects the request whose correlated response reports failure", async () => {
    const child = new FakeChild();
    const session = await startSession(child);

    const steering = session.steer("stop and inspect the diff");
    const command = child.command("steer");
    child.failure(command, "agent is not streaming");

    await expect(steering).rejects.toMatchObject({
      name: "RpcCommandError",
      id: command.id,
      command: "steer",
    });
  });

  it("sends steer and abort commands and terminates the child during disposal", async () => {
    const child = new FakeChild();
    const session = await startSession(child);

    const steering = session.steer("focus on tests");
    const steer = child.command("steer");
    expect(steer).toMatchObject({ message: "focus on tests" });
    child.success(steer);
    await steering;

    const aborting = session.abort();
    const abort = child.command("abort", 0);
    child.success(abort);
    await aborting;

    const disposing = session.dispose();
    const disposeAbort = child.command("abort", 1);
    child.success(disposeAbort);
    await disposing;

    expect(child.stdin.writable).toBe(false);
    expect(child.killSignals).toContain("SIGTERM");
  });

  it("requeues an RPC steer when handoff seals before its late queue update and response", async () => {
    const child = new FakeChild();
    const session = await startSession(child);
    const control = new RunControl({ runId: "run-1", abortSession: async () => undefined });
    await control.setActiveSession(session);

    const steering = control.steer("finish the boundary check");
    const steerCommand = child.command("steer");
    const dispatchedText = steerCommand.message;

    child.event({
      type: "tool_execution_start",
      toolCallId: "handoff-call",
      toolName: "handoff",
      args: handoffArgs,
    });
    expect(session.isSealed?.()).toBe(true);

    child.event({ type: "queue_update", steering: [dispatchedText], followUp: [] });
    child.success(steerCommand);
    await steering;

    await expect(control.steer("review the returned handoff")).resolves.toBeUndefined();
    expect(child.stdin.writes.filter((write) => JSON.parse(write).type === "steer")).toHaveLength(
      1,
    );
    expect(control.takePendingGuidance()).toEqual([
      { id: 1, mode: "steer", text: "finish the boundary check" },
      { id: 2, mode: "steer", text: "review the returned handoff" },
    ]);
  });

  it("retains a schema-invalid raw handoff without sealing", async () => {
    const child = new FakeChild();
    const session = await startSession(child);
    const malformedArgs = { target_role: "orchestrator" };

    child.event({
      type: "tool_execution_start",
      toolCallId: "malformed-handoff-call",
      toolName: "handoff",
      args: malformedArgs,
    });

    expect(session.readCaptureBuffer()).toEqual([{ toolName: "handoff", args: malformedArgs }]);
    expect(session.isSealed?.()).toBe(false);
  });

  it("keeps steering addressable after an invalid-first machine event", async () => {
    const child = new FakeChild();
    const session = await startSession(child);
    const control = new RunControl({ runId: "run-1", abortSession: async () => undefined });
    await control.setActiveSession(session);

    const steering = control.steer("finish the boundary check");
    const steerCommand = child.command("steer");
    const dispatchedText = steerCommand.message;
    const malformedArgs = { target_role: "orchestrator" };

    child.event({
      type: "tool_execution_start",
      toolCallId: "malformed-handoff-call",
      toolName: "handoff",
      args: malformedArgs,
    });
    child.event({ type: "queue_update", steering: [dispatchedText], followUp: [] });
    child.success(steerCommand);
    await steering;

    const secondSteer = control.steer("continue this active turn");
    child.success(child.command("steer", 1));
    await secondSteer;

    child.event({
      type: "tool_execution_start",
      toolCallId: "extra-end-call",
      toolName: "end",
      args: { reason: "complete" },
    });

    expect(session.readCaptureBuffer()).toEqual([
      { toolName: "handoff", args: malformedArgs },
      { toolName: "end", args: { reason: "complete" } },
    ]);
    expect(session.isSealed?.()).toBe(false);
    expect(control.takePendingGuidance()).toEqual([]);

    const thirdSteer = control.steer("remain directly steerable");
    child.success(child.command("steer", 2));
    await thirdSteer;

    expect(child.stdin.writes.filter((write) => JSON.parse(write).type === "steer")).toHaveLength(
      3,
    );
  });

  it("makes concurrent disposal idempotent while one abort is in flight", async () => {
    const child = new FakeChild();
    const session = await startSession(child);

    const first = session.dispose();
    const second = session.dispose();
    const samePromise = second === first;
    const aborts = child.stdin.writes
      .map((write) => JSON.parse(write) as Record<string, unknown>)
      .filter((command) => command.type === "abort");
    for (const abort of aborts) child.success(abort);

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(samePromise).toBe(true);
    expect(aborts).toHaveLength(1);
  });

  it("settles disposal and terminates a child that does not answer the graceful abort", async () => {
    const child = new FakeChild(true);
    const session = await startSession(child);

    await expect(session.dispose()).rejects.toMatchObject({ name: "RpcAbortTimeoutError" });
    expect(child.stdin.writable).toBe(false);
    expect(child.killSignals).toEqual(expect.arrayContaining(["SIGTERM", "SIGKILL"]));
  }, 1_000);

  it("bounds forceful disposal when a child ignores every termination signal", async () => {
    const child = new FakeChild(true, true);
    const session = await startSession(child);

    const disposing = session.dispose();
    void disposing.catch(() => undefined);
    const outcome = await Promise.race([
      disposing.then(
        () => "resolved",
        (error: unknown) => error,
      ),
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 1_000)),
    ]);

    expect(outcome).toBeInstanceOf(RpcAbortTimeoutError);
    expect(child.killSignals).toEqual(expect.arrayContaining(["SIGTERM", "SIGKILL"]));
  }, 1_500);

  it("waits for a real SIGTERM-ignoring child to exit before surfacing the abort timeout", async () => {
    const child = spawn(
      process.execPath,
      [
        "--eval",
        `
          process.on("SIGTERM", () => {});
          let buffer = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => {
            buffer += chunk;
            for (;;) {
              const newline = buffer.indexOf("\\n");
              if (newline === -1) break;
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              const command = JSON.parse(line);
              if (command.type === "get_state") {
                process.stdout.write(JSON.stringify({
                  id: command.id,
                  type: "response",
                  command: "get_state",
                  success: true,
                  data: { sessionId: "live-child", sessionFile: "/tmp/live-child.jsonl" },
                }) + "\\n");
              }
            }
          });
          process.stdin.on("end", () => {});
          setInterval(() => {}, 1_000);
        `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const session = new NodeRoleSession(
      {
        role: "implementer",
        model: "stub:isolated",
        effort: "medium",
        cwd: "/role-worktree",
        sessionDir: "/host-run/sessions",
        agentDir: "/host-agent",
        systemPrompt: "resolved role prompt",
        machineToolsConfigPath: "/role-worktree/machine-tools.json",
      },
      child,
    );
    await session.initialize();
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    await expect(session.dispose()).rejects.toMatchObject({ name: "RpcAbortTimeoutError" });

    expect(child.exitCode === null && child.signalCode === null).toBe(false);
  }, 3_000);

  it("clears the native child steering queue after a terminal handoff seals", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "pi-conductor-rpc-queue-"));
    const statePath = join(stateDir, "native-queue.json");
    const child = spawn(
      process.execPath,
      [
        "--eval",
        `
          const fs = require("node:fs");
          const statePath = process.argv[1];
          let buffer = "";
          let steering = [];
          const write = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => {
            buffer += chunk;
            for (;;) {
              const newline = buffer.indexOf("\\n");
              if (newline === -1) break;
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              const command = JSON.parse(line);
              if (command.type === "get_state") {
                write({
                  id: command.id,
                  type: "response",
                  command: "get_state",
                  success: true,
                  data: { sessionId: "queue-child", sessionFile: "/tmp/queue-child.jsonl" },
                });
                continue;
              }
              if (command.type === "steer") {
                steering.push(command.message);
                write({
                  type: "tool_execution_start",
                  toolCallId: "handoff-call",
                  toolName: "handoff",
                  args: ${JSON.stringify(handoffArgs)},
                });
                write({ type: "queue_update", steering, followUp: [] });
                write({ id: command.id, type: "response", command: "steer", success: true });
                write({
                  type: "tool_execution_end",
                  toolCallId: "handoff-call",
                  toolName: "handoff",
                  result: {},
                  isError: false,
                });
                write({ type: "agent_end", messages: [], willRetry: false });
                continue;
              }
              if (command.type === "get_session_stats") {
                steering = [];
                fs.writeFileSync(statePath, JSON.stringify({ steering, followUp: [] }));
                write({
                  id: command.id,
                  type: "response",
                  command: "get_session_stats",
                  success: true,
                  data: {
                    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    cost: 0,
                  },
                });
                process.exit(0);
              }
            }
          });
        `,
        statePath,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const session = new NodeRoleSession(
      {
        role: "implementer",
        model: "stub:isolated",
        effort: "medium",
        cwd: "/role-worktree",
        sessionDir: "/host-run/sessions",
        agentDir: "/host-agent",
        systemPrompt: "resolved role prompt",
        machineToolsConfigPath: "/role-worktree/machine-tools.json",
      },
      child,
    );
    try {
      await session.initialize();
      const control = new RunControl({ runId: "run-queue", abortSession: async () => undefined });
      await control.setActiveSession(session);

      await control.steer("preserve this next turn");
      await once(child, "exit");

      expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ steering: [], followUp: [] });
      expect(control.takePendingGuidance()).toEqual([
        { id: 1, mode: "steer", text: "preserve this next turn" },
      ]);
    } finally {
      await session.dispose();
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 3_000);

  it.each([
    "{not-json}",
    "[]",
    "null",
  ])("rejects a pending turn when the child emits malformed or non-object JSONL %s", async (frame) => {
    const child = new FakeChild();
    const session = await startSession(child);
    const prompt = session.prompt("do not hang");

    child.stdout.writeFragmented(`${frame}\n`);

    await expect(prompt).rejects.toBeInstanceOf(RpcProtocolError);
  });

  it("rejects a pending turn when valid terminal stats cannot be normalized", async () => {
    const child = new FakeChild();
    const session = await startSession(child);
    const prompt = session.prompt("fail rather than use invalid usage");

    child.success(child.command("prompt"));
    child.event({ type: "agent_end", messages: [], willRetry: false });
    await Promise.resolve();
    child.success(child.command("get_session_stats"), { tokens: {}, cost: 0 });

    await expect(prompt).rejects.toMatchObject({ name: "RpcStateError" });
  });

  it("rejects a pending turn when terminal token totals contradict their component counts", async () => {
    const child = new FakeChild();
    const session = await startSession(child);
    const prompt = session.prompt("reject contradictory usage");

    child.success(child.command("prompt"));
    child.event({ type: "agent_end", messages: [], willRetry: false });
    await Promise.resolve();
    child.success(child.command("get_session_stats"), {
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 0 },
      cost: 0,
    });

    await expect(prompt).rejects.toMatchObject({ name: "RpcStateError" });
  });

  it("rejects a pending turn when the child stdout stream errors", async () => {
    const child = new FakeChild();
    const session = await startSession(child);
    const prompt = session.prompt("do not hang on stream failure");

    child.stdout.emit("error", new Error("broken pipe"));

    await expect(prompt).rejects.toMatchObject({ name: "RpcChildProcessError" });
  });

  it("rejects a pending turn when the child exits before agent_end", async () => {
    const child = new FakeChild();
    const session = await startSession(child);
    const prompt = session.prompt("do not hang after acceptance");
    child.success(child.command("prompt"));
    child.exit(17, null);

    await expect(prompt).rejects.toBeInstanceOf(RpcChildExitError);
  });
});
