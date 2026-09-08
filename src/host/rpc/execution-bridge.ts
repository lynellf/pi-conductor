/** Host-owned RPC forwarding for confined executable file tools — issue #76. */

import { randomUUID } from "node:crypto";
import { type Dirent, realpathSync } from "node:fs";
import { access, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

const REQUEST_SUFFIX = ".request.json";
const RESPONSE_SUFFIX = ".response.json";
const CANCEL_SUFFIX = ".cancel.json";
const REQUEST_ID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const executionToolNames = ["read", "grep", "find", "ls", "edit", "write"] as const;
const executionToolNameSchema = Type.Union(executionToolNames.map((name) => Type.Literal(name)));
const modelInputSchema = Type.Object(
  { input: Type.Array(Type.String()) },
  { additionalProperties: false },
);
const executionRequestSchema = Type.Object(
  {
    id: Type.String({ pattern: REQUEST_ID_PATTERN }),
    actual_tool_call_id: Type.String({ minLength: 1 }),
    tool_name: executionToolNameSchema,
    params: Type.Unknown(),
    model_input: Type.Optional(modelInputSchema),
  },
  { additionalProperties: false },
);
const executionResponseSchema = Type.Union([
  Type.Object(
    {
      id: Type.String({ pattern: REQUEST_ID_PATTERN }),
      success: Type.Literal(true),
      result: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: Type.String({ pattern: REQUEST_ID_PATTERN }),
      success: Type.Literal(false),
      error: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

/** File tool names that may cross the isolated RPC boundary. */
export type ExecutionToolName = (typeof executionToolNames)[number];

/** Child-to-host request forwarded to one host-owned confined tool. */
export interface ExecutionBridgeRequest {
  readonly id: string;
  readonly actual_tool_call_id: string;
  readonly tool_name: ExecutionToolName;
  readonly params: unknown;
  readonly model_input?: unknown;
}

/** Host-side definition used for validation and execution of one file tool. */
export interface ExecutionBridgeToolDefinition {
  readonly name: ExecutionToolName;
  readonly parameters: TSchema;
  readonly execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal,
    modelInput: unknown,
  ) => Promise<unknown>;
}

/** Typed bridge failure for malformed requests, unavailable tools, or bad responses. */
export class ExecutionBridgeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionBridgeProtocolError";
  }
}

/** Typed failure when the bridge cannot settle owned work during close. */
export class ExecutionBridgeCloseError extends Error {
  readonly code = "execution-bridge-close-unconfirmed";

  constructor() {
    super("execution bridge closed before owned tool handlers settled");
    this.name = "ExecutionBridgeCloseError";
  }
}

/** Forward one validated file-tool call from an isolated child to its host. */
export async function requestExecutionBridge(options: {
  readonly directory: string;
  readonly actualToolCallId: string;
  readonly toolName: ExecutionToolName;
  readonly params: unknown;
  readonly modelInput?: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<unknown> {
  const id = randomUUID();
  if (options.signal?.aborted) throw new ExecutionBridgeProtocolError("execution bridge aborted");
  const directory = realpathSync(options.directory);
  const requestPath = join(directory, `${id}${REQUEST_SUFFIX}`);
  const responsePath = join(directory, `${id}${RESPONSE_SUFFIX}`);
  const cancelPath = join(directory, `${id}${CANCEL_SUFFIX}`);
  const requestTemporaryPath = join(directory, `.${id}${REQUEST_SUFFIX}.tmp`);
  const request: ExecutionBridgeRequest = {
    id,
    actual_tool_call_id: options.actualToolCallId,
    tool_name: options.toolName,
    params: options.params,
    ...(options.modelInput === undefined ? {} : { model_input: options.modelInput }),
  };
  await writeFile(requestTemporaryPath, JSON.stringify(request), { encoding: "utf8", mode: 0o600 });
  await rename(requestTemporaryPath, requestPath);
  let cancel: (() => void) | undefined;
  let hostConfirmed = false;
  let timedOut = false;
  try {
    const timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new ExecutionBridgeProtocolError("execution bridge timeout must be positive");
    }
    const result = await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let aborted = options.signal?.aborted === true;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearInterval(interval);
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => {
        aborted = true;
        void writeFile(cancelPath, JSON.stringify({ id }), { encoding: "utf8", mode: 0o600 }).catch(
          () => undefined,
        );
      };
      cancel = onAbort;
      const read = async (): Promise<void> => {
        try {
          const raw = await readFile(responsePath, "utf8");
          const parsed: unknown = JSON.parse(raw);
          if (!Value.Check(executionResponseSchema, parsed)) {
            finish(() =>
              reject(new ExecutionBridgeProtocolError("execution bridge response malformed")),
            );
            return;
          }
          if (parsed.id !== id) return;
          if (!parsed.success) {
            hostConfirmed = true;
            finish(() => reject(new ExecutionBridgeProtocolError(parsed.error)));
            return;
          }
          hostConfirmed = true;
          finish(() =>
            aborted
              ? reject(new ExecutionBridgeProtocolError("execution bridge aborted"))
              : resolve(parsed.result),
          );
        } catch {
          // The host may still be writing the response; polling retries.
        }
      };
      const interval = setInterval(() => void read(), 10);
      const timeout = setTimeout(() => {
        timedOut = true;
        onAbort();
        finish(() => reject(new ExecutionBridgeProtocolError("execution bridge timed out")));
      }, timeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      void read();
    });
    return result;
  } finally {
    if (cancel !== undefined) options.signal?.removeEventListener("abort", cancel);
    if (hostConfirmed || !timedOut) {
      await Promise.all([
        rm(requestPath, { force: true }),
        rm(responsePath, { force: true }),
        rm(cancelPath, { force: true }),
      ]);
    }
  }
}

/** Host owner that validates and executes forwarded file-tool requests. */
export class ExecutionBridgeHost {
  private readonly directory: string;
  private readonly tools: ReadonlyMap<ExecutionToolName, ExecutionBridgeToolDefinition>;
  private readonly pending = new Map<
    string,
    { readonly controller: AbortController; readonly done: Promise<void> }
  >();
  private readonly consumed = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: {
    readonly directory: string;
    readonly tools: readonly ExecutionBridgeToolDefinition[];
  }) {
    if (options.tools.length === 0)
      throw new ExecutionBridgeProtocolError("execution bridge has no tools");
    this.directory = realpathSync(options.directory);
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.timer = setInterval(() => {
      void this.scan().catch(() => undefined);
    }, 10);
    void this.scan().catch(() => undefined);
  }

  /** Stop admission, cancel owned handlers, and wait for their settlement. */
  async close(timeoutMs = 2_000): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    clearInterval(this.timer);
    this.closePromise = this.settleClose(timeoutMs);
    return this.closePromise;
  }

  private async settleClose(timeoutMs: number): Promise<void> {
    this.interruptPending();
    const pending = [...this.pending.values()].map((entry) => entry.done);
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ExecutionBridgeCloseError()), timeoutMs);
    });
    try {
      await Promise.race([Promise.all(pending), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Ask all currently admitted handlers to stop while keeping the bridge open. */
  interruptPending(): void {
    for (const pending of this.pending.values()) pending.controller.abort();
  }

  private async scan(): Promise<void> {
    if (this.closed) return;
    let entries: Dirent[];
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(REQUEST_SUFFIX)) continue;
      const id = entry.name.slice(0, -REQUEST_SUFFIX.length);
      if (this.closed || this.consumed.has(id) || this.pending.has(id)) continue;
      let responseExists = false;
      try {
        await access(join(this.directory, `${id}${RESPONSE_SUFFIX}`));
        responseExists = true;
      } catch {
        // No terminal response exists; admit the request once.
      }
      if (this.closed || this.consumed.has(id) || this.pending.has(id)) continue;
      this.consumed.add(id);
      if (responseExists) continue;
      const controller = new AbortController();
      const done = this.handle(id, controller);
      this.pending.set(id, { controller, done });
      void done.then(
        () => this.pending.delete(id),
        () => this.pending.delete(id),
      );
    }
  }

  private async handle(id: string, controller: AbortController): Promise<void> {
    let request: unknown;
    try {
      request = JSON.parse(
        await readFile(join(this.directory, `${id}${REQUEST_SUFFIX}`), "utf8"),
      ) as unknown;
    } catch {
      await this.respond(id, { id, success: false, error: "malformed execution bridge request" });
      return;
    }
    if (!Value.Check(executionRequestSchema, request) || request.id !== id) {
      await this.respond(id, {
        id,
        success: false,
        error: "malformed execution bridge request",
      }).catch(() => undefined);
      return;
    }
    const tool = this.tools.get(request.tool_name);
    if (
      tool === undefined ||
      !Value.Check(tool.parameters, request.params) ||
      (request.model_input !== undefined && !Value.Check(modelInputSchema, request.model_input))
    ) {
      await this.respond(id, {
        id,
        success: false,
        error: "undeclared or invalid file tool call",
      }).catch(() => undefined);
      return;
    }
    const cancelPath = join(this.directory, `${id}${CANCEL_SUFFIX}`);
    const cancelTimer = setInterval(async () => {
      try {
        const cancel = JSON.parse(await readFile(cancelPath, "utf8")) as { id?: unknown };
        if (cancel.id === id) controller.abort();
      } catch {
        // Cancellation is best effort; the host still owns handler settlement.
      }
    }, 10);
    try {
      const result = await tool.execute(
        request.actual_tool_call_id,
        request.params,
        controller.signal,
        request.model_input,
      );
      if (controller.signal.aborted)
        await this.respond(id, { id, success: false, error: "execution bridge request aborted" });
      else await this.respond(id, { id, success: true, result });
    } catch (error) {
      await this.respond(id, {
        id,
        success: false,
        error: error instanceof Error ? error.message : "tool execution failed",
      }).catch(() => undefined);
    } finally {
      clearInterval(cancelTimer);
    }
  }

  private async respond(id: string, response: unknown): Promise<void> {
    if (!Value.Check(executionResponseSchema, response))
      throw new ExecutionBridgeProtocolError("invalid bridge response");
    const responsePath = join(this.directory, `${id}${RESPONSE_SUFFIX}`);
    const temporaryPath = join(this.directory, `.${id}${RESPONSE_SUFFIX}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(response), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, responsePath);
  }
}
