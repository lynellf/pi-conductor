/**
 * Strict request/reply bridge for isolated RPC role delegation — Issue #48 R4.b.1.
 *
 * Pi extensions have no host callback surface, so the static extension exchanges
 * one schema-checked JSON request and reply with the owning Node role session.
 * This module deliberately knows nothing about delegation worktrees or children.
 *
 * Client, host, framing, and schemas remain together because each enforces the
 * same correlation invariant; splitting them would obscure the one bridge contract.
 */

import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { link, lstat, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { type DelegateArgs, delegateArgsSchema } from "../../seam/schema.js";

const REQUEST_SUFFIX = ".request.json";
const RESPONSE_SUFFIX = ".response.json";
const REQUEST_ID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const DEFAULT_RESPONSE_TIMEOUT_MS = 5 * 60_000;
const SCAN_INTERVAL_MS = 10;

const delegateBridgeResultSchema = Type.Object(
  {
    content: Type.Array(
      Type.Object(
        {
          type: Type.Literal("text"),
          text: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    details: Type.Record(Type.String(), Type.Unknown()),
    isError: Type.Optional(Type.Boolean()),
    terminate: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const delegateBridgeRequestSchema = Type.Object(
  {
    id: Type.String({ pattern: REQUEST_ID_PATTERN }),
    args: delegateArgsSchema,
  },
  { additionalProperties: false },
);

const delegateBridgeResponseSchema = Type.Union([
  Type.Object(
    {
      id: Type.String({ pattern: REQUEST_ID_PATTERN }),
      success: Type.Literal(true),
      result: delegateBridgeResultSchema,
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

/** Structured result returned by the host-owned delegate operation. */
export type DelegateBridgeResult = Static<typeof delegateBridgeResultSchema>;

/** Callback supplied by a later host-delegation wiring slice. */
export type DelegateBridgeHandler = (args: DelegateArgs) => Promise<DelegateBridgeResult>;

/** Typed failure for an invalid bridge configuration or a bridge path escape. */
export class DelegateBridgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegateBridgeConfigError";
  }
}

/** Typed failure for malformed, unknown, or cross-call bridge frames. */
export class DelegateBridgeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegateBridgeProtocolError";
  }
}

/** Typed failure when the current delegate tool operation has been interrupted. */
export class DelegateBridgeInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegateBridgeInterruptedError";
  }
}

/** Invoke the host-owned delegate operation from the static RPC extension. */
export async function requestDelegateBridge(options: {
  readonly directory: string;
  readonly args: DelegateArgs;
  readonly signal?: AbortSignal;
  /** Test-only bound; production uses a five-minute operation deadline. */
  readonly timeoutMs?: number;
}): Promise<DelegateBridgeResult> {
  const directory = canonicalDirectory(options.directory, "delegate bridge directory");
  if (!Value.Check(delegateArgsSchema, options.args)) {
    throw new DelegateBridgeProtocolError("delegate bridge request arguments are invalid");
  }
  if (options.signal?.aborted === true) {
    throw new DelegateBridgeInterruptedError("delegate bridge request was interrupted");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new DelegateBridgeConfigError("delegate bridge timeout must be a positive integer");
  }

  const id = randomUUID();
  const requestPath = bridgePath(directory, id, REQUEST_SUFFIX);
  const responsePath = bridgePath(directory, id, RESPONSE_SUFFIX);
  await writeJsonFrame(requestPath, { id, args: options.args });
  try {
    return await waitForResponse({
      id,
      responsePath,
      signal: options.signal,
      timeoutMs,
    });
  } finally {
    await Promise.all([rm(requestPath, { force: true }), rm(responsePath, { force: true })]);
  }
}

/** Host-side owner for one canonical per-session bridge directory. */
export class DelegateBridgeHost {
  private readonly directory: string;
  private readonly delegate: DelegateBridgeHandler;
  private readonly handledRequests = new Set<string>();
  private readonly pending = new Map<string, PendingDelegateRequest>();
  private readonly timer: ReturnType<typeof setInterval>;
  private scanning = false;
  private closed = false;

  constructor(options: {
    /** Host-owned session root. The bridge must be inside its fixed child path. */
    readonly sessionDir: string;
    readonly directory: string;
    readonly delegate: DelegateBridgeHandler;
  }) {
    this.delegate = options.delegate;
    const bridgeRoot = canonicalDirectory(
      resolve(options.sessionDir, "machine-tools", "delegate-bridge"),
      "delegate bridge root",
    );
    this.directory = canonicalDirectory(options.directory, "delegate bridge directory");
    if (!isStrictChild(this.directory, bridgeRoot)) {
      throw new DelegateBridgeConfigError(
        "delegate bridge directory escapes the host-owned per-session bridge root",
      );
    }
    this.timer = setInterval(() => {
      void this.scan();
    }, SCAN_INTERVAL_MS);
    void this.scan();
  }

  /** Interrupt only outstanding calls while leaving the bridge usable for a later turn. */
  interruptPending(): void {
    for (const pending of this.pending.values()) {
      if (!pending.active) continue;
      pending.active = false;
      void this.writeFailure(pending.id, "host delegate operation unavailable");
    }
  }

  /** Stop accepting requests and fail any outstanding call at its own correlated path. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    // The host callback may be external work. Do not let it delay child teardown;
    // `active` already prevents a late resolution from becoming a success reply.
    this.interruptPending();
  }

  private async scan(): Promise<void> {
    if (this.closed || this.scanning || this.directory.length === 0) return;
    this.scanning = true;
    try {
      const entries = await readdir(this.directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(REQUEST_SUFFIX)) continue;
        const id = entry.name.slice(0, -REQUEST_SUFFIX.length);
        if (!isRequestId(id) || this.handledRequests.has(id)) continue;
        this.handledRequests.add(id);
        const pending: PendingDelegateRequest = {
          id,
          active: true,
          done: Promise.resolve(),
        };
        pending.done = this.handleRequest(pending);
        this.pending.set(id, pending);
        void pending.done.finally(() => this.pending.delete(id));
      }
    } catch {
      this.closed = true;
      clearInterval(this.timer);
      this.interruptPending();
    } finally {
      this.scanning = false;
    }
  }

  private async handleRequest(pending: PendingDelegateRequest): Promise<void> {
    let request: unknown | null;
    try {
      request = await readJsonRegularFile(bridgePath(this.directory, pending.id, REQUEST_SUFFIX));
    } catch {
      return;
    }
    if (
      request === null ||
      !Value.Check(delegateBridgeRequestSchema, request) ||
      request.id !== pending.id ||
      this.closed ||
      !pending.active
    ) {
      return;
    }

    let result: DelegateBridgeResult;
    try {
      result = await this.delegate(request.args);
    } catch {
      if (pending.active && !this.closed) {
        await this.writeFailure(pending.id, "host delegate operation unavailable");
      }
      return;
    }
    if (!pending.active || this.closed) return;
    if (!Value.Check(delegateBridgeResultSchema, result)) {
      await this.writeFailure(pending.id, "host delegate operation returned an invalid result");
      return;
    }
    await this.writeResponse(pending.id, { id: pending.id, success: true, result });
  }

  private async writeFailure(id: string, error: string): Promise<void> {
    await this.writeResponse(id, { id, success: false, error });
  }

  private async writeResponse(
    id: string,
    response: Static<typeof delegateBridgeResponseSchema>,
  ): Promise<void> {
    try {
      if (!Value.Check(delegateBridgeResponseSchema, response)) return;
      await writeJsonFrame(bridgePath(this.directory, id, RESPONSE_SUFFIX), response);
    } catch {
      // A child-created file or an I/O failure must not redirect a host response.
    }
  }
}

interface PendingDelegateRequest {
  readonly id: string;
  active: boolean;
  done: Promise<void>;
}

async function waitForResponse(options: {
  readonly id: string;
  readonly responsePath: string;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}): Promise<DelegateBridgeResult> {
  return new Promise<DelegateBridgeResult>((resolveResponse, rejectResponse) => {
    let settled = false;
    let reading = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const reject = (error: Error): void => settle(() => rejectResponse(error));
    const onAbort = (): void =>
      reject(new DelegateBridgeInterruptedError("delegate bridge request was interrupted"));
    const readResponse = async (): Promise<void> => {
      if (settled || reading) return;
      reading = true;
      try {
        const response = await readJsonRegularFile(options.responsePath);
        if (response === null) return;
        if (!Value.Check(delegateBridgeResponseSchema, response)) {
          reject(new DelegateBridgeProtocolError("delegate bridge response is malformed"));
          return;
        }
        if (response.id !== options.id) {
          reject(
            new DelegateBridgeProtocolError("delegate bridge response belongs to another request"),
          );
          return;
        }
        if (!response.success) {
          reject(new DelegateBridgeInterruptedError(response.error));
          return;
        }
        settle(() => resolveResponse(response.result));
      } catch {
        reject(new DelegateBridgeProtocolError("delegate bridge response could not be read"));
      } finally {
        reading = false;
      }
    };
    const interval = setInterval(() => {
      void readResponse();
    }, SCAN_INTERVAL_MS);
    const timeout = setTimeout(
      () => reject(new DelegateBridgeInterruptedError("delegate bridge response timed out")),
      options.timeoutMs,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    void readResponse();
  });
}

function canonicalDirectory(path: string, field: string): string {
  if (!isAbsolute(path)) {
    throw new DelegateBridgeConfigError(`${field} must be an absolute path`);
  }
  try {
    const resolved = realpathSync(path);
    if (!statSync(resolved).isDirectory()) {
      throw new DelegateBridgeConfigError(`${field} must be a directory`);
    }
    return resolved;
  } catch (error) {
    if (error instanceof DelegateBridgeConfigError) throw error;
    throw new DelegateBridgeConfigError(`${field} is unavailable`);
  }
}

function bridgePath(
  directory: string,
  id: string,
  suffix: typeof REQUEST_SUFFIX | typeof RESPONSE_SUFFIX,
): string {
  if (!isRequestId(id)) {
    throw new DelegateBridgeProtocolError("delegate bridge request identifier is invalid");
  }
  const candidate = resolve(directory, `${id}${suffix}`);
  if (!isStrictChild(candidate, directory)) {
    throw new DelegateBridgeConfigError("delegate bridge frame path escapes its directory");
  }
  return candidate;
}

function isRequestId(id: string): boolean {
  return new RegExp(REQUEST_ID_PATTERN).test(id);
}

function isStrictChild(candidate: string, root: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function readJsonRegularFile(path: string): Promise<unknown | null> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new DelegateBridgeProtocolError("delegate bridge frame is not a regular file");
    }
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error instanceof DelegateBridgeProtocolError) throw error;
    throw new DelegateBridgeProtocolError("delegate bridge frame is not valid JSON");
  }
}

async function writeJsonFrame(path: string, value: unknown): Promise<void> {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new DelegateBridgeProtocolError("delegate bridge frame is not serializable");
  }
  if (serialized === undefined) {
    throw new DelegateBridgeProtocolError("delegate bridge frame is not serializable");
  }
  const directory = resolve(path, "..");
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await link(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
