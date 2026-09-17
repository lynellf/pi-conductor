/** Bounded trusted local effect execution boundary for issue #117. */

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
  type LocalProgramInvocation,
  type LocalProgramOutcome,
  localProgramInvocationSchema,
  localProgramOutcomeSchema,
} from "../../manifest/local-effect.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { runSupervisedProcess, SupervisedProcessError } from "../execution/supervised-process.js";
import {
  findProcessesByOwnerToken,
  type ProcessIdentity,
  readProcessSessionMembers,
} from "../execution/supervised-process-identity.js";
import { captureToolAdmission, restoreToolAdmission } from "../execution/tool-admission.js";
import { effectAuthorityDigest } from "./effect-registry.js";
import { measureGitEffectRepository } from "./git-effect.js";
import { assertCommit, readRef } from "./git-effect-operations.js";
import { measureLocalProgramImplementation } from "./local-effect-measurement.js";
import {
  assertLocalProgramRequestInScope,
  assertLocalProgramResultInScope,
  localProgramOperation,
} from "./local-effect-registry.js";
import {
  type LocalProgramProcessAdmission,
  type LocalProgramRecoveryAttempt,
  type LocalProgramRecoveryObservation,
  LocalProgramRuntimeError,
  type LocalProgramRuntimeResult,
  type RunTrustedLocalEffectProgramOptions,
} from "./local-effect-runtime-contract.js";
import { readProtectedCredentialFile } from "./remote-effect.js";

export {
  type LocalProgramInvocationInput,
  type LocalProgramProcessAdmission,
  type LocalProgramProcessSettlement,
  type LocalProgramProviderApproval,
  type LocalProgramRecoveryAttempt,
  type LocalProgramRecoveryObservation,
  LocalProgramRuntimeError,
  type LocalProgramRuntimeGrant,
  type LocalProgramRuntimeResult,
  type RunTrustedLocalEffectProgramOptions,
} from "./local-effect-runtime-contract.js";

/** Capture original-host recovery evidence before the broker persists attempt intent. */
export async function captureLocalProgramProcessAdmission(): Promise<LocalProgramProcessAdmission> {
  return Object.freeze({
    supervisionId: randomUUID(),
    admission: await captureToolAdmission(),
  });
}

/** Observe an interrupted attempt without killing or replaying it. */
export async function inspectLocalProgramProcessAdmission(
  attempt: LocalProgramRecoveryAttempt,
): Promise<LocalProgramRecoveryObservation> {
  try {
    const scope = await restoreToolAdmission(attempt.admission);
    const marked = await findProcessesByOwnerToken(attempt.supervisionId, undefined, scope);
    const sessionId = attempt.spawnedIdentity?.sessionId;
    const sessionMembers =
      sessionId === undefined || attempt.spawnedIdentity === undefined
        ? []
        : await readProcessSessionMembers(sessionId, attempt.spawnedIdentity.startTime, scope);
    const processes = [
      ...new Map([...marked, ...sessionMembers].map((process) => [process.pid, process])).values(),
    ];
    return Object.freeze({
      state: processes.length === 0 ? "stopped" : "live",
      processes: Object.freeze([...processes]),
    });
  } catch {
    return Object.freeze({ state: "unconfirmed", processes: Object.freeze([]) });
  }
}

/**
 * Run one fixed trusted provider step using closed stdin/stdout JSON.
 *
 * The reviewed provider remains privileged host code. Repository and network names in the JSON
 * protocol are context for that trusted code; they do not create an OS or network sandbox.
 */
export async function runTrustedLocalEffectProgram(
  options: RunTrustedLocalEffectProgramOptions,
): Promise<LocalProgramRuntimeResult> {
  options.signal?.throwIfAborted();
  await options.assertInvocationOpen();
  await verifyPreflight(options);
  const credentials = loadCredentials(options);
  let input: Buffer | undefined;
  let privateDirectory: string | undefined;
  let released = false;
  let identity: ProcessIdentity | null = null;
  let settlementAttempted = false;
  try {
    const invocation = buildInvocation(options, credentials);
    input = Buffer.from(JSON.stringify(invocation), "utf8");
    if (input.byteLength > options.grant.max_input_bytes)
      throw preflight(
        "local-effect-input-too-large",
        "local provider invocation exceeds its limit",
      );
    const root = await canonicalPrivateRoot(options.workspaceRoot);
    privateDirectory = await mkdtemp(join(root, "local-effect-"));
    const result = await runSupervisedProcess({
      executionId: options.processAdmission.supervisionId,
      file: options.grant.provider.executable.canonical_path,
      args: options.grant.provider.argv,
      stdin: input,
      deferStdinUntilSpawn: true,
      cwd: privateDirectory,
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
      inheritEnv: false,
      timeoutMs: options.grant.timeout_seconds * 1_000,
      outputLimitBytes: options.grant.max_output_bytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onStart: () => undefined,
      onSpawn: async (spawned) => {
        identity = spawned;
        await options.onSpawn(spawned);
        await measureLocalProgramImplementation(options.grant, options.hostDriverDigest);
        await assertRepositoryAndHead(options);
        options.signal?.throwIfAborted();
        await options.assertInvocationOpen();
        released = true;
      },
    });
    const cleanup = await observeAttemptCleanup(options, identity);
    settlementAttempted = true;
    await persistSettlement(options, cleanup, "completed", identity);
    if (cleanup !== "confirmed") return uncertain("local-effect-process-cleanup-unconfirmed");
    if (result.exitCode !== 0 || result.signal !== null)
      return uncertain("local-effect-lost-response");
    if (result.truncated) return uncertain("local-effect-output-too-large");
    const outputBytes = Buffer.from(result.stdout, "utf8");
    try {
      if (credentials.some((credential) => outputBytes.includes(credential.value)))
        return uncertain("local-effect-credential-echo");
      return parseOutcome(options, invocation, result.stdout);
    } finally {
      outputBytes.fill(0);
    }
  } catch (cause) {
    if (settlementAttempted) throw cause;
    const supervised = cause instanceof SupervisedProcessError ? cause : undefined;
    if (identity !== null || supervised?.identity != null) {
      const observedCleanup = await observeAttemptCleanup(
        options,
        identity ?? supervised?.identity ?? null,
      );
      settlementAttempted = true;
      await persistSettlement(
        options,
        supervised?.cleanup === "confirmed" && observedCleanup === "confirmed"
          ? "confirmed"
          : "unconfirmed",
        supervised?.code === "supervised-process-timeout"
          ? "timed_out"
          : supervised?.code === "supervised-process-aborted"
            ? "aborted"
            : "failed",
        identity ?? supervised?.identity ?? null,
      );
    }
    if (released) return uncertain(diagnosticFor(cause));
    if (cause instanceof LocalProgramRuntimeError) throw cause;
    throw preflight("local-effect-rejected", "local provider rejected before invocation", cause);
  } finally {
    input?.fill(0);
    for (const credential of credentials) credential.value.fill(0);
    if (privateDirectory !== undefined)
      await rm(privateDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function observeAttemptCleanup(
  options: RunTrustedLocalEffectProgramOptions,
  identity: ProcessIdentity | null,
): Promise<"confirmed" | "unconfirmed"> {
  const observed = await inspectLocalProgramProcessAdmission({
    ...options.processAdmission,
    ...(identity === null ? {} : { spawnedIdentity: identity }),
  });
  return observed.state === "stopped" ? "confirmed" : "unconfirmed";
}

async function verifyPreflight(options: RunTrustedLocalEffectProgramOptions): Promise<void> {
  const { grant, invocation } = options;
  localProgramOperation(grant, invocation.request.operation);
  assertLocalProgramRequestInScope(grant, invocation.request);
  if (
    invocation.implementation_id !== grant.implementation_id ||
    invocation.implementation_digest !== grant.implementation_digest ||
    invocation.authority_digest !== effectAuthorityDigest(grant) ||
    invocation.request_digest !== sha256Canonical(invocation.request)
  )
    throw preflight("local-effect-identity-mismatch", "local invocation identity is inconsistent");
  verifyEvidence(invocation);
  await measureLocalProgramImplementation(grant, options.hostDriverDigest);
  await assertRepositoryAndHead(options);
}

async function assertRepositoryAndHead(
  options: RunTrustedLocalEffectProgramOptions,
): Promise<void> {
  const repository = await measureGitEffectRepository(options.grant.repository.canonical_path);
  if (
    repository.canonical_path !== options.grant.repository.canonical_path ||
    repository.fingerprint !== options.grant.repository.fingerprint ||
    options.invocation.request.repository_id !== options.grant.repository.id
  )
    throw preflight("local-effect-repository-mismatch", "local provider repository changed");
  await assertCommit(repository.canonical_path, options.invocation.request.reviewed_head);
  if (options.invocation.command === "execute") {
    const head = await readRef(repository.canonical_path, options.invocation.request.source_ref);
    if (head !== options.invocation.request.reviewed_head)
      throw preflight("local-effect-head-mismatch", "local provider source ref changed");
  }
}

function verifyEvidence(invocation: RunTrustedLocalEffectProgramOptions["invocation"]): void {
  const claims = new Map(invocation.request.evidence.map((entry) => [entry.artifact_ref, entry]));
  if (
    claims.size !== invocation.request.evidence.length ||
    invocation.evidence.length !== claims.size
  )
    throw preflight("local-effect-evidence-mismatch", "local invocation evidence is incomplete");
  for (const evidence of invocation.evidence) {
    const claim = claims.get(evidence.artifact_ref);
    const bytes = Buffer.from(evidence.bytes_base64, "base64");
    try {
      if (
        claim === undefined ||
        claim.sha256 !== evidence.sha256 ||
        createHash("sha256").update(bytes).digest("hex") !== evidence.sha256 ||
        bytes.toString("base64") !== evidence.bytes_base64
      )
        throw preflight("local-effect-evidence-mismatch", "local invocation evidence changed");
    } finally {
      bytes.fill(0);
    }
  }
}

function loadCredentials(options: RunTrustedLocalEffectProgramOptions) {
  const credentials: { readonly sourceId: string; readonly value: Buffer }[] = [];
  try {
    for (const sourceId of options.grant.provider.credential_source_ids)
      credentials.push(
        Object.freeze({
          sourceId,
          value: readProtectedCredentialFile(sourceId, options.credentialFiles),
        }),
      );
    return Object.freeze(credentials);
  } catch (cause) {
    for (const credential of credentials) credential.value.fill(0);
    throw cause;
  }
}

function buildInvocation(
  options: RunTrustedLocalEffectProgramOptions,
  credentials: readonly { readonly sourceId: string; readonly value: Buffer }[],
): LocalProgramInvocation {
  const value: LocalProgramInvocation = {
    ...structuredClone(options.invocation),
    scope: {
      repository_path: options.grant.repository.canonical_path,
      repository_fingerprint: options.grant.repository.fingerprint,
      allowed_network_origins: [...options.grant.provider.network.allowed_origins],
    },
    credentials: credentials.map(({ sourceId, value }) => ({
      source_id: sourceId,
      value: value.toString("utf8"),
    })),
  };
  if (!Value.Check(localProgramInvocationSchema, value))
    throw preflight("local-effect-protocol-invalid", "local provider invocation is invalid");
  return value;
}

function parseOutcome(
  options: RunTrustedLocalEffectProgramOptions,
  invocation: LocalProgramInvocation,
  stdout: string,
): LocalProgramRuntimeResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return uncertain("local-effect-malformed-output");
  }
  if (!Value.Check(localProgramOutcomeSchema, value))
    return uncertain("local-effect-malformed-output");
  const outcome = value as LocalProgramOutcome;
  for (const field of [
    "operation_id",
    "invocation_id",
    "implementation_id",
    "implementation_digest",
    "authority_digest",
    "request_digest",
  ] as const)
    if (outcome[field] !== invocation[field]) return uncertain("local-effect-identity-mismatch");
  try {
    if (outcome.status === "applied")
      assertLocalProgramResultInScope(options.grant, invocation.request, outcome.result);
    else if (outcome.status === "not_applied")
      assertLocalProgramResultInScope(options.grant, invocation.request, outcome.observation);
    else if (outcome.observation !== undefined)
      assertLocalProgramResultInScope(options.grant, invocation.request, outcome.observation);
  } catch {
    return uncertain("local-effect-result-out-of-scope");
  }
  return Object.freeze({ kind: "outcome", outcome: structuredClone(outcome) });
}

async function canonicalPrivateRoot(path: string): Promise<string> {
  const canonical = await realpath(path);
  const stat = await lstat(canonical);
  if (
    canonical !== path ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw preflight(
      "local-effect-workspace-unsafe",
      "local provider workspace root must be canonical host-owned mode 0700",
    );
  return canonical;
}

async function persistSettlement(
  options: RunTrustedLocalEffectProgramOptions,
  cleanup: "confirmed" | "unconfirmed",
  outcome: "completed" | "failed" | "timed_out" | "aborted",
  identity: ProcessIdentity | null,
): Promise<void> {
  await options.onSettled({
    operationId: options.invocation.operation_id,
    invocationId: options.invocation.invocation_id,
    supervisionId: options.processAdmission.supervisionId,
    cleanup,
    outcome,
    identity,
  });
}

function uncertain(diagnosticCode: string): LocalProgramRuntimeResult {
  return Object.freeze({ kind: "uncertain", diagnosticCode });
}

function diagnosticFor(cause: unknown): string {
  if (cause instanceof SupervisedProcessError) {
    if (cause.code === "supervised-process-timeout") return "local-effect-timeout";
    if (cause.code === "supervised-process-aborted") return "local-effect-aborted";
    return "local-effect-process-failed";
  }
  return "local-effect-lost-response";
}

function preflight(code: string, message: string, cause?: unknown): LocalProgramRuntimeError {
  return new LocalProgramRuntimeError(code, message, cause === undefined ? undefined : { cause });
}
