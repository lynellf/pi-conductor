import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { CompactionObservation } from "../orchestrator-context-compaction.js";

const uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const rawUsageSchema = Type.Object(
  {
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cacheRead: Type.Number({ minimum: 0 }),
    cacheWrite: Type.Number({ minimum: 0 }),
    totalTokens: Type.Number({ minimum: 0 }),
    cost: Type.Object(
      {
        input: Type.Number({ minimum: 0 }),
        output: Type.Number({ minimum: 0 }),
        cacheRead: Type.Number({ minimum: 0 }),
        cacheWrite: Type.Number({ minimum: 0 }),
        total: Type.Number({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const contextUsageSchema = Type.Object(
  {
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cache_read: Type.Number({ minimum: 0 }),
    cache_write: Type.Number({ minimum: 0 }),
    tokens: Type.Number({ minimum: 0 }),
    cost: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const startPayload = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    beforeTip: Type.Union([Type.String(), Type.Null()]),
    beforeTokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const outcomePayload = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    beforeTip: Type.Union([Type.String(), Type.Null()]),
    afterTip: Type.Optional(Type.String()),
    beforeTokens: Type.Integer({ minimum: 0 }),
    usage: Type.Union([contextUsageSchema, Type.Null()]),
    rawUsages: Type.Array(Type.Union([rawUsageSchema, Type.Null()])),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const settledPayload = Type.Object(
  {
    conversationId: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    sessionFile: Type.String({ minLength: 1 }),
    leafId: Type.Union([Type.String(), Type.Null()]),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const requestSchema = Type.Union([
  Type.Object(
    { id: uuid, kind: Type.Literal("start"), payload: startPayload },
    { additionalProperties: false },
  ),
  Type.Object(
    { id: uuid, kind: Type.Literal("outcome"), payload: outcomePayload },
    { additionalProperties: false },
  ),
  Type.Object(
    { id: uuid, kind: Type.Literal("settled"), payload: settledPayload },
    { additionalProperties: false },
  ),
]);
const responseSchema = Type.Object(
  {
    id: uuid,
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
type Request = Static<typeof requestSchema>;
type Response = Static<typeof responseSchema>;
export type RpcContextStartPayload = Static<typeof startPayload>;
export type RpcContextOutcomePayload = Static<typeof outcomePayload>;
export type RpcContextSettledPayload = Static<typeof settledPayload>;

/** Host ACK issued before an RPC child may begin a provider request. */
export interface RpcContextStart {
  readonly requestId: string;
  readonly beforeTip: string | null;
  readonly beforeTokens: number;
}

/** Durable host handlers used by the isolated RPC context bridge. */
export interface RpcContextRetentionHandlers {
  readonly start: (payload: RpcContextStartPayload) => void | Promise<void>;
  readonly outcome: (payload: RpcContextOutcomePayload) => void | Promise<void>;
  readonly settled: (payload: RpcContextSettledPayload) => void | Promise<void>;
}

/** Parent/child bridge for durable context-retention acknowledgements. */
export interface RpcContextRetentionBridge {
  readonly onStart: (start: RpcContextStart) => void | Promise<void>;
  readonly onUsage: (chargeId: string, usage: Usage | null) => void;
  readonly onObservation: (observation: CompactionObservation) => void | Promise<void>;
  readonly settle: () => void | Promise<void>;
  readonly assertHealthy: () => void;
  readonly getCompactionUsage?: () => import("../../core/types.js").UsageRecord;
}

/** Typed failure for a rejected or unavailable context-retention ACK. */
export class RpcContextRetentionError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RpcContextRetentionError";
    this.cause = cause;
  }
}

/** Polling host endpoint for atomic request/reply frames from a trusted child. */
export class RpcContextRetentionHost {
  private readonly loop: Promise<void>;
  private closed = false;
  private readonly seen = new Set<string>();
  private failure: Error | undefined;

  private constructor(
    readonly directory: string,
    private readonly handlers: RpcContextRetentionHandlers,
    private readonly intervalMs: number,
  ) {
    this.loop = this.poll();
  }

  /** Create a mode-0700 request directory and start its host poller. */
  static async create(
    directory: string,
    handlers: RpcContextRetentionHandlers,
    options: { readonly intervalMs?: number } = {},
  ): Promise<RpcContextRetentionHost> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return new RpcContextRetentionHost(directory, handlers, options.intervalMs ?? 10);
  }

  /** Stop polling after the current frame handlers finish. */
  async close(): Promise<void> {
    this.closed = true;
    await this.loop;
  }

  /** Throw the first host polling failure observed by the bridge. */
  assertHealthy(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  private async poll(): Promise<void> {
    while (!this.closed) {
      try {
        const entries = await readdir(this.directory);
        for (const name of entries.filter((entry) => entry.endsWith(".request.json"))) {
          await this.handle(name);
        }
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.closed = true;
      }
      await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
    }
  }

  private async handle(name: string): Promise<void> {
    const requestPath = join(this.directory, name);
    const responsePath = requestPath.replace(".request.json", ".response.json");
    const expectedId = name.slice(0, -".request.json".length);
    let response: Response;
    try {
      const value: unknown = JSON.parse(await readFile(requestPath, "utf8"));
      if (!Value.Check(requestSchema, value)) throw new Error("malformed context request");
      const request = value as Request;
      if (request.id !== expectedId) throw new Error("context request filename does not match id");
      if (this.seen.has(request.id)) throw new Error("duplicate context request");
      this.seen.add(request.id);
      if (request.kind === "start") await this.handlers.start(request.payload);
      if (request.kind === "outcome") await this.handlers.outcome(request.payload);
      if (request.kind === "settled") await this.handlers.settled(request.payload);
      response = { id: request.id, ok: true };
    } catch (error) {
      response = { id: expectedId, ok: false, error: String(error) };
    }
    const temporary = `${responsePath}.tmp-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(response)}\n`, { mode: 0o600 });
    await rename(temporary, responsePath);
    await rm(requestPath, { force: true });
  }
}

/** Send one bounded child request and await its atomic host response. */
export async function requestRpcContext(
  directory: string,
  kind: Request["kind"],
  payload: Record<string, unknown>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<void> {
  const id = randomUUID();
  const requestPath = join(directory, `${id}.request.json`);
  const responsePath = join(directory, `${id}.response.json`);
  const temporary = `${requestPath}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify({ id, kind, payload })}\n`, { mode: 0o600 });
  await rename(temporary, requestPath);
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  try {
    while (Date.now() < deadline) {
      try {
        const value: unknown = JSON.parse(await readFile(responsePath, "utf8"));
        if (!Value.Check(responseSchema, value)) throw new Error("malformed context response");
        const response = value as Response;
        if (response.id !== id) throw new Error("context response correlation mismatch");
        if (!response.ok) throw new Error(response.error ?? "context request failed");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 10));
          continue;
        }
        throw error;
      }
    }
    throw new Error(`context request ${id} timed out`);
  } finally {
    await Promise.all([rm(requestPath, { force: true }), rm(responsePath, { force: true })]);
  }
}
