/** Exact authenticated remote delivery with explicit idempotency reconciliation — issue #116. */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import type { DeliverRefRequest, EffectResult } from "../../manifest/controller-effect.js";
import { validateEffectResult } from "../../manifest/controller-effect.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import {
  assertEffectRequestInScope,
  assertEffectResultInScope,
  type PinnedEffectAuthority,
} from "./effect-registry.js";

const MAX_CREDENTIAL_BYTES = 8 * 1024;
const MAX_DIAGNOSTIC = 256;

export interface RemoteEffectPrepared {
  readonly operationId: string;
  readonly authorityDigest: string;
  readonly requestDigest: string;
  readonly remoteId: string;
  readonly exactOrigin: string;
  readonly exactPath: string;
  readonly targetRef: string;
  readonly reviewedHead: string;
  readonly expectedPrior: string | null;
  readonly idempotencyKey: string;
  readonly credentialSourceId: string;
}

export type RemoteEffectObservation =
  | {
      readonly kind: "applied";
      readonly result: Extract<EffectResult, { readonly kind: "deliver_ref" }>;
      readonly remoteObjectOid: string;
      readonly priorOid: string | null;
    }
  | { readonly kind: "not_applied"; readonly observedOid: string | null }
  | { readonly kind: "unknown"; readonly diagnosticCode: string };

export interface RemoteEffectOptions {
  readonly authority: PinnedEffectAuthority;
  readonly request: DeliverRefRequest;
  readonly operationId: string;
  readonly credentialFiles: Readonly<Record<string, string>>;
  readonly persistPrepared: (prepared: RemoteEffectPrepared) => void | Promise<void>;
  readonly assertOpen: () => void;
  readonly signal?: AbortSignal;
}

/** Persist intent, fence immediately before send, and execute one exact remote effect. */
export async function executeRemoteEffect(
  options: RemoteEffectOptions,
): Promise<RemoteEffectObservation> {
  const remote = requireRemote(options.authority, options.request);
  const credential = readProtectedCredentialFile(
    remote.credential_source_id,
    options.credentialFiles,
  );
  try {
    const prepared = preparedRecord(options, remote);
    const body = Buffer.from(JSON.stringify(options.request), "utf8");
    await options.persistPrepared(prepared);
    options.assertOpen();
    options.signal?.throwIfAborted();
    return observeResponse(
      options,
      await sendExact({
        origin: remote.exact_origin,
        path: remote.exact_path,
        method: remote.method,
        credential,
        idempotencyKey: options.request.idempotency_key,
        body,
        maxBytes: options.authority.grant.max_output_bytes,
        timeoutMs: options.authority.grant.timeout_seconds * 1000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
  } finally {
    credential.fill(0);
  }
}

/** Query the same pinned endpoint and idempotency key; this never replays the write. */
export async function reconcileRemoteEffect(
  options: Omit<RemoteEffectOptions, "persistPrepared">,
): Promise<RemoteEffectObservation> {
  const remote = requireRemote(options.authority, options.request);
  const credential = readProtectedCredentialFile(
    remote.credential_source_id,
    options.credentialFiles,
  );
  try {
    options.assertOpen();
    options.signal?.throwIfAborted();
    const response = await sendExact({
      origin: remote.exact_origin,
      path: remote.exact_path,
      method: "GET",
      credential,
      idempotencyKey: options.request.idempotency_key,
      body: null,
      maxBytes: options.authority.grant.max_output_bytes,
      timeoutMs: options.authority.grant.timeout_seconds * 1000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return observeQuery(options, response);
  } finally {
    credential.fill(0);
  }
}

/** Read one explicitly named private credential file without returning its path in diagnostics. */
export function readProtectedCredentialFile(
  credentialSourceId: string,
  credentialFiles: Readonly<Record<string, string>>,
): Buffer {
  const path = credentialFiles[credentialSourceId];
  if (path === undefined) throw new Error("remote effect credential source is unavailable");
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(path);
    if (canonicalPath !== resolve(path))
      throw new Error("remote effect credential file is not protected");
  } catch (cause) {
    if (safeCredentialError(cause)) throw cause;
    throw new Error("remote effect credential file is unavailable");
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error("remote effect credential file is unavailable");
  }
  try {
    const before = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      !before.isFile() ||
      before.uid !== uid ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      before.size < 1 ||
      before.size > MAX_CREDENTIAL_BYTES ||
      realpathSync(`/proc/self/fd/${descriptor}`) !== canonicalPath
    )
      throw new Error("remote effect credential file is not protected");
    const buffer = Buffer.allocUnsafe(MAX_CREDENTIAL_BYTES + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const count = readSync(descriptor, buffer, length, buffer.byteLength - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    if (
      length !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("remote effect credential file changed while reading");
    const value = Buffer.from(buffer.subarray(0, length));
    if (value.some((byte) => byte < 0x21 || byte > 0x7e))
      throw new Error("remote effect credential file has invalid bytes");
    return value;
  } catch (cause) {
    if (safeCredentialError(cause)) throw cause;
    throw new Error("remote effect credential file is unavailable");
  } finally {
    closeSync(descriptor);
  }
}

function safeCredentialError(value: unknown): value is Error {
  return value instanceof Error && value.message.startsWith("remote effect credential file");
}

interface ExactResponse {
  readonly status: number;
  readonly body: Buffer;
  readonly uncertain?: string;
}

async function sendExact(input: {
  readonly origin: string;
  readonly path: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly credential: Buffer;
  readonly idempotencyKey: string;
  readonly body: Buffer | null;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<ExactResponse> {
  const url = new URL(input.path, `${input.origin}/`);
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ExactResponse) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = transport(
      url,
      {
        method: input.method,
        headers: {
          authorization: `Bearer ${input.credential.toString("utf8")}`,
          "idempotency-key": input.idempotencyKey,
          accept: "application/json",
          ...(input.body === null
            ? {}
            : { "content-type": "application/json", "content-length": input.body.byteLength }),
        },
        signal: input.signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > input.maxBytes) {
            request.destroy();
            finish({
              status: response.statusCode ?? 0,
              body: Buffer.alloc(0),
              uncertain: "response_too_large",
            });
          } else chunks.push(chunk);
        });
        response.on("end", () =>
          finish({ status: response.statusCode ?? 0, body: Buffer.concat(chunks, bytes) }),
        );
        response.on("error", () =>
          finish({
            status: response.statusCode ?? 0,
            body: Buffer.alloc(0),
            uncertain: "response_error",
          }),
        );
      },
    );
    request.setTimeout(input.timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", (error: NodeJS.ErrnoException) =>
      finish({
        status: 0,
        body: Buffer.alloc(0),
        uncertain: error.name === "AbortError" ? "aborted_after_send" : "transport_ambiguous",
      }),
    );
    if (input.body !== null) request.write(input.body);
    request.end();
  });
}

function observeResponse(
  options: Pick<RemoteEffectOptions, "authority" | "request">,
  response: ExactResponse,
): RemoteEffectObservation {
  if (response.uncertain !== undefined) return unknown(response.uncertain);
  const value = parseJson(response.body);
  if (response.status === 200) return applied(options, value);
  if (response.status === 409 || response.status === 412)
    return nonApplication(options.request, value);
  return unknown(
    response.status >= 300 && response.status < 400 ? "redirect_rejected" : "unverified_response",
  );
}

function observeQuery(
  options: Pick<RemoteEffectOptions, "authority" | "request">,
  response: ExactResponse,
): RemoteEffectObservation {
  if (response.uncertain !== undefined || response.status !== 200)
    return unknown(response.uncertain ?? "query_unverified");
  const value = parseJson(response.body);
  if (!isObject(value) || value.schema_version !== 1) return unknown("query_invalid");
  if (value.status === "applied") return applied(options, value.result);
  if (value.status === "not_applied") return nonApplication(options.request, value);
  if (value.status === "unknown") return unknown("service_unknown");
  return unknown("query_invalid");
}

function applied(
  options: Pick<RemoteEffectOptions, "authority" | "request">,
  value: unknown,
): RemoteEffectObservation {
  try {
    const result = validateEffectResult("deliver_ref", value);
    assertEffectResultInScope(options.authority, options.request, result);
    if (result.kind !== "deliver_ref") return unknown("result_kind_mismatch");
    return {
      kind: "applied",
      result,
      remoteObjectOid: result.remote_object_oid,
      priorOid: result.prior_remote_oid,
    };
  } catch {
    return unknown("result_verification_failed");
  }
}

function nonApplication(request: DeliverRefRequest, value: unknown): RemoteEffectObservation {
  if (
    !isObject(value) ||
    value.schema_version !== 1 ||
    value.status !== "not_applied" ||
    value.idempotency_key !== request.idempotency_key ||
    !(value.observed_oid === null || isObjectId(value.observed_oid))
  )
    return unknown("nonapplication_unverified");
  return { kind: "not_applied", observedOid: value.observed_oid };
}

function requireRemote(authority: PinnedEffectAuthority, request: DeliverRefRequest) {
  assertEffectRequestInScope(authority, request);
  if (authority.grant.kind !== "deliver_ref")
    throw new Error("remote effect requires pinned delivery authority");
  return authority.grant.remote;
}

function preparedRecord(
  options: RemoteEffectOptions,
  remote: Extract<PinnedEffectAuthority["grant"], { kind: "deliver_ref" }>["remote"],
): RemoteEffectPrepared {
  return Object.freeze({
    operationId: options.operationId,
    authorityDigest: options.authority.authority_digest,
    requestDigest: sha256Canonical(options.request),
    remoteId: options.request.remote_id,
    exactOrigin: remote.exact_origin,
    exactPath: remote.exact_path,
    targetRef: options.request.target_ref,
    reviewedHead: options.request.reviewed_head,
    expectedPrior: options.request.expected_remote_oid,
    idempotencyKey: options.request.idempotency_key,
    credentialSourceId: remote.credential_source_id,
  });
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value);
}

function unknown(code: string): RemoteEffectObservation {
  return { kind: "unknown", diagnosticCode: code.slice(0, MAX_DIAGNOSTIC) };
}
