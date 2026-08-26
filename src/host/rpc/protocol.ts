/** Shared transport types and validation for the Issue #48 Node RPC adapter. */

import { StringDecoder } from "node:string_decoder";

import type {
  ModelEffort,
  Role,
  SessionWorkspaceDescriptor,
  UsageRecord,
} from "../../core/types.js";
import type { ArtifactCollectionContext } from "../artifacts/lifecycle.js";
import type { DelegateBridgeHandler, RequestFilesBridgeHandler } from "./delegate-bridge.js";

/** All-zero usage before the first child turn settles. */
export const ZERO_USAGE: UsageRecord = Object.freeze({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  tokens: 0,
  cost: 0,
}) as UsageRecord;

/** A writable child-process stream used by the injected RPC process seam. */
export interface RpcWritable {
  readonly writable?: boolean;
  readonly destroyed?: boolean;
  write(chunk: string): boolean;
  end?(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** A readable child-process stream used by the injected RPC process seam. */
export interface RpcReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** Minimal child-process boundary for deterministic adapter tests. */
export interface RpcChildProcess {
  readonly stdin: RpcWritable;
  readonly stdout: RpcReadable;
  readonly stderr?: RpcReadable;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Arguments passed through the injected child-process factory. */
export interface RpcSpawnOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Test seam for substituting the Node child process. */
export type RpcChildSpawner = (options: RpcSpawnOptions) => RpcChildProcess;

/** Options for starting a Node RPC role session. */
export interface NodeRoleSessionOptions {
  readonly role: Role;
  readonly model: string | null;
  readonly effort: ModelEffort;
  /** Provisioned isolated role workspace. */
  readonly cwd: string;
  /** Host-owned run session directory supplied to Pi's `--session-dir` flag. */
  readonly sessionDir: string;
  /** Host-owned Pi agent configuration directory supplied through the environment. */
  readonly agentDir: string;
  /** Resolved role prompt, or null to preserve Pi's configured default prompt. */
  readonly systemPrompt: string | null;
  /** Absolute path to the mandatory host-written machine-tools configuration file. */
  readonly machineToolsConfigPath: string;
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly workspace?: SessionWorkspaceDescriptor;
  /** Actual host-provisioned artifact roots for terminal collection. */
  readonly artifactCollection?: ArtifactCollectionContext;
  /** Explicit host callback and canonical per-session directory for isolated delegation. */
  readonly delegateBridge?: {
    readonly directory: string;
    readonly delegate: DelegateBridgeHandler;
  };
  /** Explicit host callback and canonical per-session directory for progressive disclosure. */
  readonly requestFilesBridge?: {
    readonly directory: string;
    readonly requestFiles: RequestFilesBridgeHandler;
  };
  readonly env?: NodeJS.ProcessEnv;
  /** Release host session tracking after the child has been terminated. */
  readonly onDispose?: () => Promise<void> | void;
  /** Test-only process factory. Omit to spawn the package-local pi CLI. */
  readonly spawn?: RpcChildSpawner;
}

/** Base error for failures at the isolated pi RPC boundary. */
export class RpcRoleSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcRoleSessionError";
  }
}

/** The child emitted a non-JSON or structurally invalid RPC frame. */
export class RpcProtocolError extends RpcRoleSessionError {
  constructor(message: string) {
    super(message);
    this.name = "RpcProtocolError";
  }
}

/** A correlated RPC command response reported failure. */
export class RpcCommandError extends RpcRoleSessionError {
  readonly id: string;
  readonly command: string;

  constructor(id: string, command: string, message: string) {
    super(`RPC command '${command}' (${id}) failed: ${message}`);
    this.name = "RpcCommandError";
    this.id = id;
    this.command = command;
  }
}

/** Required state or statistics data was absent or invalid in a successful RPC response. */
export class RpcStateError extends RpcRoleSessionError {
  constructor(message: string) {
    super(message);
    this.name = "RpcStateError";
  }
}

/** The RPC child exited before the adapter could finish its current operation. */
export class RpcChildExitError extends RpcRoleSessionError {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(code: number | null, signal: NodeJS.Signals | null, stderr: string) {
    super(
      `RPC child exited before session settlement (code=${String(code)} signal=${String(signal)})${
        stderr.length === 0 ? "" : `: ${stderr}`
      }`,
    );
    this.name = "RpcChildExitError";
    this.code = code;
    this.signal = signal;
  }
}

/** The RPC child or one of its streams reported an operating-system error. */
export class RpcChildProcessError extends RpcRoleSessionError {
  constructor(message: string) {
    super(message);
    this.name = "RpcChildProcessError";
  }
}

/** The child did not acknowledge the bounded graceful abort during disposal. */
export class RpcAbortTimeoutError extends RpcRoleSessionError {
  constructor() {
    super("RPC child did not acknowledge abort before disposal timeout");
    this.name = "RpcAbortTimeoutError";
  }
}

/** A caller addressed an already-disposed isolated role session. */
export class RpcSessionDisposedError extends RpcRoleSessionError {
  constructor() {
    super("RPC role session has been disposed");
    this.name = "RpcSessionDisposedError";
  }
}

/** A JSON object sent to the child over the strict RPC JSONL channel. */
export interface RpcCommand {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** A successful or failed response frame correlated by the host-generated ID. */
export interface RpcResponseFrame {
  readonly id: string;
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

/** Split child stdout with literal-LF JSONL semantics, stripping only a trailing CR. */
export class RpcJsonlReader {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: Buffer | string): readonly string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const frames: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return frames;
      const frame = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      frames.push(frame.endsWith("\r") ? frame.slice(0, -1) : frame);
    }
  }
}

/** Parse one strict JSONL frame as a protocol object. */
export function parseRpcFrame(frame: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    throw new RpcProtocolError("RPC child emitted malformed JSONL");
  }
  if (!isObject(value)) throw new RpcProtocolError("RPC child emitted a non-object JSONL frame");
  return value;
}

/** Narrow an external JSON value to a protocol object. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a non-empty string field without coercing protocol data. */
export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Require a non-empty string from a successful child state response. */
export function requiredString(
  value: Record<string, unknown>,
  field: string,
  command: string,
): string {
  const result = optionalString(value[field]);
  if (result === null) throw new RpcStateError(`RPC ${command} response is missing ${field}`);
  return result;
}

/** Require object-shaped response data from the RPC child. */
export function objectData(data: unknown, command: string): Record<string, unknown> {
  if (!isObject(data)) throw new RpcStateError(`RPC ${command} response is missing object data`);
  return data;
}

/** Normalize pi's cumulative session stats to the conductor UsageRecord seam. */
export function normalizeStats(data: unknown): UsageRecord {
  const stats = objectData(data, "get_session_stats");
  const tokens = objectData(stats.tokens, "get_session_stats.tokens");
  const input = requiredNumber(tokens, "input");
  const output = requiredNumber(tokens, "output");
  const cacheRead = requiredNumber(tokens, "cacheRead");
  const cacheWrite = requiredNumber(tokens, "cacheWrite");
  const total = requiredNumber(tokens, "total");
  if (total !== input + output + cacheRead + cacheWrite) {
    throw new RpcStateError("RPC get_session_stats response has inconsistent token total");
  }
  return {
    input,
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    tokens: total,
    cost: requiredNumber(stats, "cost"),
  };
}

/** Convert unexpected JavaScript failures into the typed RPC error family. */
export function asRpcError(error: unknown): RpcRoleSessionError {
  if (error instanceof RpcRoleSessionError) return error;
  return new RpcChildProcessError(error instanceof Error ? error.message : String(error));
}

function requiredNumber(value: Record<string, unknown>, field: string): number {
  const result = value[field];
  if (typeof result !== "number" || !Number.isFinite(result) || result < 0) {
    throw new RpcStateError(`RPC get_session_stats response has invalid ${field}`);
  }
  return result;
}
