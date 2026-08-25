import { EventEmitter } from "node:events";
import { join } from "node:path";
import type {
  NodeRoleSessionOptions,
  RpcChildProcess,
} from "../../../src/host/rpc/node-role-session.js";
import { createNodeRoleSession } from "../../../src/host/rpc/node-role-session-factory.js";

export class HostFakeRpcWritable extends EventEmitter {
  readonly writes: string[] = [];
  writable = true;
  destroyed = false;
  onWrite: ((chunk: string) => void) | undefined;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    this.onWrite?.(chunk);
    return true;
  }

  end(): void {
    this.writable = false;
  }
}

export class HostFakeRpcReadable extends EventEmitter {
  frame(value: Record<string, unknown>): void {
    this.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  }
}

/** Fake JSONL child used to exercise ProductionHost's isolated RPC selection. */
export class HostFakeRpcChild extends EventEmitter implements RpcChildProcess {
  readonly stdin = new HostFakeRpcWritable();
  readonly stdout = new HostFakeRpcReadable();
  readonly stderr = new HostFakeRpcReadable();
  readonly killSignals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    });
    return true;
  }

  command(type: string, occurrence = 0): Record<string, unknown> {
    const command = this.stdin.writes
      .map((write) => JSON.parse(write) as Record<string, unknown>)
      .filter((candidate) => candidate.type === type)[occurrence];
    if (command === undefined) throw new Error(`missing ${type} RPC command`);
    return command;
  }

  success(command: Record<string, unknown>, data?: unknown): void {
    this.stdout.frame({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      ...(data === undefined ? {} : { data }),
    });
  }

  event(event: Record<string, unknown>): void {
    this.stdout.frame(event);
  }
}

/** Create an isolated-session factory that automatically emits a valid handoff. */
export function createAutomaticIsolatedRoleSessionFactory(
  args: {
    onPrompt?: (options: NodeRoleSessionOptions, child: HostFakeRpcChild) => Promise<void> | void;
  } = {},
) {
  return async (options: NodeRoleSessionOptions) => {
    const child = new HostFakeRpcChild();
    const starting = createNodeRoleSession({ ...options, spawn: () => child });
    child.success(child.command("get_state"), {
      sessionId: `automatic-${options.role}`,
      sessionFile: join(options.sessionDir, `automatic-${options.role}.jsonl`),
    });
    const session = await starting;
    child.stdin.onWrite = (write) => {
      const command = JSON.parse(write) as Record<string, unknown>;
      if (command.type === "abort") {
        child.success(command);
        return;
      }
      if (command.type !== "prompt") return;
      void Promise.resolve(args.onPrompt?.(options, child)).then(() => {
        child.success(command);
        child.event({
          type: "tool_execution_start",
          toolCallId: `handoff-${options.role}`,
          toolName: "handoff",
          args: {
            target_role: "orchestrator",
            status: "ready",
            objective: "return control",
            summary: "automatic isolated role test session",
            requested_action: "continue",
          },
        });
        child.event({ type: "agent_end", messages: [], willRetry: false });
        setTimeout(() => {
          child.success(child.command("get_session_stats"), {
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: 0,
          });
        }, 0);
      });
    };
    return session;
  };
}
