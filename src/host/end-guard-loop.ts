import { randomUUID } from "node:crypto";
import {
  type EndGuardFinishedRecord,
  type EndGuardRecord,
  type EndGuardStartedRecord,
  endGuardBudgetExhausted,
} from "../persistence/end-guard.js";
import type { PersistedRecord } from "../persistence/log.js";
import { capErrorDiagnostic } from "./bounded-diagnostic.js";
import type { EndGuardConfig, EndGuardRunRequest, EndGuardRunResult } from "./end-guard-runner.js";
import type { Host, RoleSession } from "./host.js";

/** Result consumed by the loop after one durable guard attempt. */
export interface EndGuardAttemptOutcome {
  readonly kind: "passed" | "retry" | "exhausted" | "aborted" | "fatal";
  readonly diagnostic: string;
}

export interface EndGuardAttemptArgs {
  readonly host: Host;
  readonly session: RoleSession;
  readonly runId: string;
  readonly role: string;
  readonly requestId: string;
  readonly config: EndGuardConfig;
  readonly records: () => readonly EndGuardRecord[];
  readonly persist: (record: PersistedRecord) => void;
}

/** Run one persisted guard attempt; all append ordering remains loop-owned. */
export async function runEndGuardAttempt(
  args: EndGuardAttemptArgs,
): Promise<EndGuardAttemptOutcome> {
  if (endGuardBudgetExhausted(args.records(), args.requestId)) {
    return { kind: "exhausted", diagnostic: "end guard retry budget exhausted" };
  }
  if (args.host.runEndGuard === undefined) {
    throw new Error("configured end_guard requires Host.runEndGuard");
  }

  const attemptId = randomUUID();
  const supervisionId = `end-guard:${attemptId}`;
  const timeoutMs = (args.config.timeout_seconds ?? 60) * 1_000;
  const started: EndGuardStartedRecord = {
    type: "end_guard_started",
    schema_version: 1,
    run_id: args.runId,
    attempt_id: attemptId,
    supervision_id: supervisionId,
    request_id: args.requestId,
    role: args.role,
    role_session_id: args.session.sessionId,
    session_file: args.session.sessionFile,
    timeout_ms: timeoutMs,
    ts: Date.now(),
  };
  args.persist(started);

  const request: EndGuardRunRequest = {
    attemptId,
    supervisionId,
    roleSessionId: args.session.sessionId,
    config: args.config,
  };
  let result: EndGuardRunResult;
  try {
    result = await args.host.runEndGuard(request);
  } catch (error) {
    // Once the durable start exists, a rejected runner promise cannot prove
    // that no process was admitted. Preserve the conservative cleanup stop.
    const diagnostic = capErrorDiagnostic(error instanceof Error ? error.message : String(error));
    result = {
      attemptId,
      roleSessionId: args.session.sessionId,
      outcome: "cleanup_unconfirmed",
      exitCode: null,
      signal: null,
      elapsedMs: 0,
      output: diagnostic.output,
      truncated: diagnostic.truncated,
      cleanup: "unconfirmed",
    };
  }
  if (result.attemptId !== attemptId || result.roleSessionId !== args.session.sessionId) {
    throw new Error("end guard runner returned mismatched attempt identity");
  }

  const finished: EndGuardFinishedRecord = {
    type: "end_guard_finished",
    schema_version: 1,
    run_id: args.runId,
    attempt_id: result.attemptId,
    supervision_id: supervisionId,
    request_id: args.requestId,
    role: args.role,
    role_session_id: result.roleSessionId,
    session_file: args.session.sessionFile,
    elapsed_ms: result.elapsedMs,
    outcome: result.outcome,
    exit_code: result.exitCode,
    signal: result.signal,
    diagnostic: result.output,
    truncated: result.truncated,
    cleanup: result.cleanup,
    ts: Date.now(),
  };
  args.persist(finished);

  if (result.outcome === "passed") return { kind: "passed", diagnostic: result.output };
  if (result.outcome === "aborted") return { kind: "aborted", diagnostic: result.output };
  if (result.outcome === "cleanup_unconfirmed") {
    return { kind: "fatal", diagnostic: result.output };
  }
  return {
    kind: endGuardBudgetExhausted(args.records(), args.requestId) ? "exhausted" : "retry",
    diagnostic: result.output,
  };
}
