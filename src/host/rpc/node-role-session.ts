/**
 * Node RPC-backed RoleSession adapter — Issue #48 remediation R3.
 *
 * Isolated roles run pi in a distinct Node process. This adapter owns the
 * role-session seam while RpcChildTransport owns strict JSONL transport;
 * ProductionHost selection and machine-tools configuration are separate.
 */

import { realpathSync } from "node:fs";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  ModelEffort,
  Role,
  SessionWorkspaceDescriptor,
  UsageRecord,
} from "../../core/types.js";
import { type EmissionCapture, validateEmission } from "../../seam/validate-emission.js";
import type { ArtifactCollectionContext } from "../artifacts/lifecycle.js";
import type { RoleSession } from "../host.js";

import { DelegateBridgeHost } from "./delegate-bridge.js";
import { loadMachineToolsConfig, MACHINE_TOOLS_CONFIG_ENV } from "./machine-tools-config.js";
import { RpcChildTerminator } from "./node-role-process.js";
import { RpcChildTransport } from "./node-role-transport.js";
import {
  asRpcError,
  type NodeRoleSessionOptions,
  normalizeStats,
  objectData,
  optionalString,
  RpcAbortTimeoutError,
  RpcChildExitError,
  type RpcChildProcess,
  RpcChildProcessError,
  type RpcCommand,
  RpcProtocolError,
  type RpcResponseFrame,
  type RpcRoleSessionError,
  RpcSessionDisposedError,
  RpcStateError,
  requiredString,
  ZERO_USAGE,
} from "./protocol.js";

export {
  resolveMachineToolsExtensionPath,
  resolvePackageLocalPiCli,
  spawnPackageLocalPi,
} from "./node-role-process.js";
export type {
  NodeRoleSessionOptions,
  RpcChildProcess,
  RpcChildSpawner,
  RpcReadable,
  RpcSpawnOptions,
  RpcWritable,
} from "./protocol.js";
export {
  RpcAbortTimeoutError,
  RpcChildExitError,
  RpcChildProcessError,
  RpcCommandError,
  RpcProtocolError,
  RpcRoleSessionError,
  RpcSessionDisposedError,
  RpcStateError,
} from "./protocol.js";

const DISPOSE_ABORT_TIMEOUT_MS = 250;

interface PendingTurn {
  accepted: boolean;
  ended: boolean;
  statsRequested: boolean;
  stats: UsageRecord | null;
  readonly resolve: () => void;
  readonly reject: (error: RpcRoleSessionError) => void;
}

/** RoleSession implementation that maps the existing seam onto pi's RPC protocol. */
export class NodeRoleSession implements RoleSession {
  readonly role: Role;
  readonly model: string | null;
  readonly effort: ModelEffort;
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly workspace?: SessionWorkspaceDescriptor;
  readonly artifactCollection?: ArtifactCollectionContext;
  private readonly terminator: RpcChildTerminator;
  private readonly transport: RpcChildTransport;
  private readonly delegateBridge: DelegateBridgeHost | null;
  private readonly onDispose: (() => Promise<void> | void) | undefined;
  private readonly captures: EmissionCapture[] = [];
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly sealedListeners = new Set<() => void>();
  private steeringQueue: string[] = [];
  private followUpQueue: string[] = [];
  private sealed = false;
  private failure: RpcRoleSessionError | null = null;
  private pendingTurn: PendingTurn | null = null;
  private terminalStatsRequested = false;
  private disposing = false;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private _sessionId = "";
  private _sessionFile = "";
  private usage: UsageRecord = ZERO_USAGE;

  constructor(options: NodeRoleSessionOptions, child: RpcChildProcess) {
    this.role = options.role;
    this.model = options.model;
    this.effort = options.effort;
    if (options.retries !== undefined) this.retries = options.retries;
    if (options.retryDelayMs !== undefined) this.retryDelayMs = options.retryDelayMs;
    if (options.workspace !== undefined) {
      this.workspace = Object.freeze({ ...options.workspace }) as SessionWorkspaceDescriptor;
    }
    if (options.artifactCollection !== undefined) {
      this.artifactCollection = Object.freeze({
        ...options.artifactCollection,
        projection: Object.freeze({
          workspaceRoot: options.artifactCollection.projection.workspaceRoot,
          mounts: Object.freeze(
            options.artifactCollection.projection.mounts.map((mount) =>
              Object.freeze({ ...mount }),
            ),
          ),
        }),
      }) as ArtifactCollectionContext;
    }
    this.terminator = new RpcChildTerminator(child);
    this.delegateBridge =
      options.delegateBridge === undefined && options.requestFilesBridge === undefined
        ? null
        : createDelegateBridge(options);
    this.onDispose = options.onDispose;
    this.transport = new RpcChildTransport(child, {
      onEvent: (value) => this.acceptEvent(value),
      onFailure: (error) => this.fail(error),
      onExit: (code, signal, stderr) => {
        this.terminator.markExited();
        void this.delegateBridge?.close();
        this.fail(new RpcChildExitError(code, signal, stderr));
      },
      hasFailed: () => this.failure !== null,
    });
  }

  /** Session identifier reported by the child through `get_state`. */
  get sessionId(): string {
    return this._sessionId;
  }

  /** Session-file path reported by the child through `get_state`. */
  get sessionFile(): string {
    return this._sessionFile;
  }

  /** Query state once so RoleSession identity is child-authored rather than host-invented. */
  async initialize(): Promise<void> {
    const response = await this.request({ type: "get_state" });
    const state = objectData(response.data, "get_state");
    this._sessionId = requiredString(state, "sessionId", "get_state");
    this._sessionFile = requiredString(state, "sessionFile", "get_state");
  }

  readCaptureBuffer(): readonly EmissionCapture[] {
    return Object.freeze([...this.captures]);
  }

  resetCaptureBuffer(): void {
    this.captures.length = 0;
    this.sealed = false;
  }

  /** Return the latest child queue snapshot; terminal tool completion then shuts down the child queue. */
  clearQueue(): { steering: string[]; followUp: string[] } {
    const steering = [...this.steeringQueue];
    const followUp = [...this.followUpQueue];
    this.steeringQueue = [];
    this.followUpQueue = [];
    return { steering, followUp };
  }

  /** Whether a terminating machine-tool capture has made the child non-addressable. */
  isSealed(): boolean {
    return this.sealed;
  }

  /** Subscribe to machine-tool capture sealing so RunControl can reclaim native steering. */
  subscribeSealed(listener: () => void): () => void {
    this.sealedListeners.add(listener);
    return () => this.sealedListeners.delete(listener);
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send native RPC steering and wait for command acceptance. */
  async steer(text: string): Promise<void> {
    await this.request({ type: "steer", message: text });
  }

  /** Ask the RPC child to abort its current agent operation. */
  async abort(): Promise<void> {
    this.delegateBridge?.interruptPending();
    await this.request({ type: "abort" });
  }

  /** Return cumulative usage normalized from the most recently settled turn's session stats. */
  captureUsage(): UsageRecord {
    return this.usage;
  }

  prompt(text: string): Promise<void> {
    this.assertOpen();
    if (this.pendingTurn !== null) {
      throw new RpcStateError("cannot issue a prompt while a prior RPC turn is unsettled");
    }
    return new Promise<void>((resolve, reject) => {
      const turn: PendingTurn = {
        accepted: false,
        ended: false,
        statsRequested: false,
        stats: null,
        resolve,
        reject,
      };
      this.pendingTurn = turn;
      void this.request({ type: "prompt", message: text }).then(
        () => {
          if (this.pendingTurn !== turn) return;
          turn.accepted = true;
          this.settleTurnIfReady(turn);
        },
        (error: RpcRoleSessionError) => this.rejectTurn(turn, error),
      );
    });
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    this.disposePromise = this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.disposing = true;
    let abortFailure: RpcRoleSessionError | null = null;
    try {
      if (this.failure === null) {
        try {
          await this.abortDuringDispose();
        } catch (error) {
          abortFailure = asRpcError(error);
        }
      }
    } finally {
      this.disposed = true;
      this.fail(new RpcSessionDisposedError());
      await this.delegateBridge?.close();
      try {
        await this.terminator.terminateAndWait();
      } finally {
        await this.onDispose?.();
      }
    }
    if (abortFailure !== null && !(abortFailure instanceof RpcChildExitError)) {
      throw abortFailure;
    }
  }

  /** End the child process without waiting, used only after startup failure. */
  terminate(): void {
    void this.delegateBridge?.close();
    this.terminator.terminate();
  }

  private acceptEvent(value: Record<string, unknown>): void {
    if (value.type === "queue_update") {
      const steering = stringArray(value.steering);
      const followUp = stringArray(value.followUp);
      if (steering === null || followUp === null) {
        this.fail(
          new RpcProtocolError("queue_update is missing string steering or followUp queues"),
        );
        return;
      }
      this.steeringQueue = steering;
      this.followUpQueue = followUp;
    }
    if (value.type === "tool_execution_start") {
      const toolName = optionalString(value.toolName);
      if (toolName === null || !("args" in value)) {
        this.fail(new RpcProtocolError("tool_execution_start is missing toolName or args"));
        return;
      }
      if (toolName === "handoff" || toolName === "end") {
        const capture: EmissionCapture =
          toolName === "handoff" ? { toolName, args: value.args } : { toolName, args: value.args };
        this.captures.push(capture);
        // Shared seam parity: only a first, schema-valid capture seals.
        // A subsequent call remains unsealed because it is extra_emission.
        if (this.captures.length === 1 && validateEmission([capture]).kind === "ok") {
          this.seal();
        }
      }
    }
    if (
      value.type === "agent_end" &&
      (!Array.isArray(value.messages) || typeof value.willRetry !== "boolean")
    ) {
      this.fail(new RpcProtocolError("agent_end is missing messages or willRetry"));
      return;
    }
    for (const listener of this.listeners) listener(value as unknown as AgentSessionEvent);
    if (value.type === "agent_end" && value.willRetry === false) {
      const turn = this.pendingTurn;
      if (turn !== null) {
        turn.ended = true;
        this.settleTurnIfReady(turn);
      } else if (this.sealed) {
        this.requestTerminalStats();
      }
    }
  }

  private seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    for (const listener of this.sealedListeners) listener();
  }

  private async abortDuringDispose(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.request({ type: "abort" }, true),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new RpcAbortTimeoutError()), DISPOSE_ABORT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  /** Request final child statistics only after a non-retrying terminal event. */
  private requestTerminalStats(): void {
    if (this.terminalStatsRequested || this.failure !== null) return;
    this.terminalStatsRequested = true;
    void this.request({ type: "get_session_stats" }).then(
      (response) => {
        try {
          this.usage = normalizeStats(response.data);
        } catch (error) {
          this.fail(asRpcError(error));
        }
      },
      (error: RpcRoleSessionError) => this.fail(error),
    );
  }

  private settleTurnIfReady(turn: PendingTurn): void {
    if (!turn.accepted || !turn.ended) return;
    if (turn.stats === null) {
      this.requestTurnStats(turn);
      return;
    }
    if (this.pendingTurn !== turn) return;
    this.pendingTurn = null;
    turn.resolve();
  }

  private requestTurnStats(turn: PendingTurn): void {
    if (turn.statsRequested || this.failure !== null) return;
    turn.statsRequested = true;
    void this.request({ type: "get_session_stats" }).then(
      (response) => {
        if (this.pendingTurn !== turn) return;
        try {
          const usage = normalizeStats(response.data);
          this.usage = usage;
          turn.stats = usage;
          this.settleTurnIfReady(turn);
        } catch (error) {
          this.rejectTurn(turn, asRpcError(error));
        }
      },
      (error: RpcRoleSessionError) => this.rejectTurn(turn, error),
    );
  }

  private rejectTurn(turn: PendingTurn, error: RpcRoleSessionError): void {
    if (this.pendingTurn !== turn) return;
    this.pendingTurn = null;
    turn.reject(error);
  }

  private request(command: RpcCommand, allowDisposing = false): Promise<RpcResponseFrame> {
    return this.transport.request(command, () => this.assertOpen(allowDisposing));
  }

  private fail(error: RpcRoleSessionError): void {
    if (this.failure !== null) return;
    this.failure = error;
    this.delegateBridge?.interruptPending();
    this.transport.rejectPending(error);
    if (this.pendingTurn !== null) {
      const turn = this.pendingTurn;
      this.pendingTurn = null;
      turn.reject(error);
    }
  }

  private assertOpen(allowDisposing = false): void {
    if (this.failure !== null) throw this.failure;
    if (this.disposed || (this.disposing && !allowDisposing)) {
      throw new RpcSessionDisposedError();
    }
  }
}

function createDelegateBridge(options: NodeRoleSessionOptions): DelegateBridgeHost {
  const delegateBridge = options.delegateBridge;
  const requestFilesBridge = options.requestFilesBridge;
  if (delegateBridge === undefined && requestFilesBridge === undefined) {
    throw new RpcChildProcessError("RPC machine tool bridge options are missing");
  }
  try {
    const config = loadMachineToolsConfig({
      [MACHINE_TOOLS_CONFIG_ENV]: options.machineToolsConfigPath,
    });
    if (delegateBridge !== undefined) {
      if (config.delegateBridge === undefined || !config.declaredToolNames.includes("delegate")) {
        throw new RpcChildProcessError(
          "RPC delegate bridge requires a delegate-enabled machine-tools configuration",
        );
      }
      if (realpathSync(delegateBridge.directory) !== config.delegateBridge.directory) {
        throw new RpcChildProcessError(
          "RPC delegate bridge directory does not match the machine-tools configuration",
        );
      }
    }
    if (requestFilesBridge !== undefined) {
      if (
        config.requestFilesBridge === undefined ||
        !config.declaredToolNames.includes("request_files")
      ) {
        throw new RpcChildProcessError(
          "RPC request_files bridge requires a request_files-enabled machine-tools configuration",
        );
      }
      if (realpathSync(requestFilesBridge.directory) !== config.requestFilesBridge.directory) {
        throw new RpcChildProcessError(
          "RPC request_files bridge directory does not match the machine-tools configuration",
        );
      }
    }
    const directory = delegateBridge?.directory ?? requestFilesBridge?.directory;
    if (directory === undefined) {
      throw new RpcChildProcessError("RPC machine tool bridge directory is missing");
    }
    if (
      delegateBridge !== undefined &&
      requestFilesBridge !== undefined &&
      realpathSync(delegateBridge.directory) !== realpathSync(requestFilesBridge.directory)
    ) {
      throw new RpcChildProcessError("RPC machine tool bridge handlers must share one directory");
    }
    return new DelegateBridgeHost({
      sessionDir: options.sessionDir,
      directory,
      ...(delegateBridge === undefined ? {} : { delegate: delegateBridge.delegate }),
      ...(requestFilesBridge === undefined
        ? {}
        : { requestFiles: requestFilesBridge.requestFiles }),
    });
  } catch (error) {
    if (error instanceof RpcChildProcessError) throw error;
    throw new RpcChildProcessError(
      `RPC machine tool bridge configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return [...value];
}
