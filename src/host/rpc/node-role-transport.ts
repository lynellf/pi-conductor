/** Strict JSONL child transport for the isolated Node RPC role-session adapter. */

import { randomUUID } from "node:crypto";

import {
  asRpcError,
  optionalString,
  parseRpcFrame,
  RpcChildExitError,
  type RpcChildProcess,
  RpcChildProcessError,
  type RpcCommand,
  RpcCommandError,
  RpcJsonlReader,
  RpcProtocolError,
  type RpcResponseFrame,
  type RpcRoleSessionError,
} from "./protocol.js";

interface PendingRequest {
  readonly command: string;
  readonly resolve: (response: RpcResponseFrame) => void;
  readonly reject: (error: RpcRoleSessionError) => void;
}

/** Callbacks that project raw child frames onto one RoleSession's lifecycle. */
export interface RpcChildTransportHandlers {
  readonly onEvent: (value: Record<string, unknown>) => void;
  readonly onFailure: (error: RpcRoleSessionError) => void;
  readonly onExit: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => void;
  readonly hasFailed: () => boolean;
}

/** Own strict JSONL parsing, command correlation, and child stream observation. */
export class RpcChildTransport {
  private readonly reader = new RpcJsonlReader();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private stderr = "";

  constructor(
    private readonly child: RpcChildProcess,
    private readonly handlers: RpcChildTransportHandlers,
  ) {
    this.attach();
  }

  /** Send one host command after the session has confirmed it is still addressable. */
  request(command: RpcCommand, assertOpen: () => void): Promise<RpcResponseFrame> {
    assertOpen();
    const id = randomUUID();
    const payload = { id, ...command };
    return new Promise<RpcResponseFrame>((resolve, reject) => {
      this.pendingRequests.set(id, { command: command.type, resolve, reject });
      try {
        if (this.child.stdin.destroyed === true || this.child.stdin.writable === false) {
          throw new RpcChildProcessError("RPC child stdin is not writable");
        }
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        const failure = asRpcError(error);
        this.pendingRequests.delete(id);
        reject(failure);
        this.handlers.onFailure(failure);
      }
    });
  }

  /** Reject all unsettled commands when the owning session enters a terminal failure state. */
  rejectPending(error: RpcRoleSessionError): void {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
  }

  private attach(): void {
    this.child.stdout.on("data", (chunk) => this.acceptChunk(chunk));
    this.child.stdout.on("end", () => {
      this.handlers.onFailure(new RpcChildExitError(null, null, this.stderr));
    });
    this.child.stdout.on("error", (error) =>
      this.handlers.onFailure(this.streamError("stdout", error)),
    );
    this.child.stderr?.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4096);
    });
    this.child.stderr?.on("error", (error) =>
      this.handlers.onFailure(this.streamError("stderr", error)),
    );
    this.child.stdin.on("error", (error) =>
      this.handlers.onFailure(this.streamError("stdin", error)),
    );
    this.child.on("error", (error) => this.handlers.onFailure(this.streamError("process", error)));
    this.child.on("exit", (code, signal) => this.handlers.onExit(code, signal, this.stderr));
  }

  private acceptChunk(chunk: Buffer | string): void {
    for (const frame of this.reader.push(chunk)) {
      try {
        const value = parseRpcFrame(frame);
        if (value.type === "response") this.acceptResponse(value);
        else if (typeof value.type === "string" && value.type.length > 0)
          this.handlers.onEvent(value);
        else
          this.handlers.onFailure(
            new RpcProtocolError("RPC child event frame is missing a string type"),
          );
      } catch (error) {
        this.handlers.onFailure(asRpcError(error));
      }
      if (this.handlers.hasFailed()) return;
    }
  }

  private acceptResponse(value: Record<string, unknown>): void {
    const id = optionalString(value.id);
    const command = optionalString(value.command);
    if (id === null || command === null || typeof value.success !== "boolean") {
      this.handlers.onFailure(
        new RpcProtocolError("RPC response is missing id, command, or success"),
      );
      return;
    }
    const pending = this.pendingRequests.get(id);
    if (pending === undefined || pending.command !== command) {
      this.handlers.onFailure(
        new RpcProtocolError(`RPC response '${id}' does not match a pending ${command} request`),
      );
      return;
    }
    this.pendingRequests.delete(id);
    if (!value.success) {
      const message = optionalString(value.error) ?? "unspecified RPC command failure";
      pending.reject(new RpcCommandError(id, command, message));
      return;
    }
    pending.resolve({
      id,
      command,
      success: true,
      ...("data" in value ? { data: value.data } : {}),
    });
  }

  private streamError(stream: string, error: Error): RpcChildProcessError {
    return new RpcChildProcessError(`RPC child ${stream} error: ${error.message}`);
  }
}
