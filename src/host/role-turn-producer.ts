/**
 * Bounded structured role-turn telemetry producer — Issue #68.
 *
 * The pi-coupled half of the `role_turn` producer. The pure value types,
 * limit resolution, deterministic limit algorithm, record validation, and
 * counter reconstruction live in `src/persistence/role-turn.js` (host-agnostic,
 * zero pi imports). This module is the only neighbour that imports the SDK
 * `AssistantMessage` and maps its structured `content` array into capture
 * candidates, and it owns the run-scoped sequence + counter ledger for the
 * live loop.
 *
 * A single {@link RoleTurnProducer} is run-owned: it is constructed once per
 * host, seeded from the durable `role_turn` stream (so a resume starts at the
 * next sequence and restores counters), and shared by every logical-role
 * session subscription in the run. Each live invocation supplies a narrow
 * {@link RoleTurnProducerContext} carrying its identity and durable-append
 * seam; the producer builds one bounded {@link RoleTurnRecord} per eligible
 * assistant `message_end` and routes it through that seam.
 *
 * The producer never calls `reduce`, `reduceLifecycle`, `prompt`, `abort`, or
 * a cost roll-up. It is observability-only (spec §2 / §6).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Role } from "../core/types.js";
import type { RecordLog } from "../persistence/log.js";
import {
  buildRoleTurnCapture,
  computeRoleTurnSaturated,
  type ResolvedRoleTurnTelemetry,
  type RoleTurnCaptureCounters,
  type RoleTurnIdentity,
  type RoleTurnRecord,
  RoleTurnRunMismatchError,
  type RoleTurnTelemetryLimits,
  RoleTurnTelemetryLogError,
  type RoleTurnTelemetryOptions,
  rebuildRoleTurnLedger,
  resolveRoleTurnLimits,
} from "../persistence/role-turn.js";

// Re-export the host-constructor telemetry option type so callers construct
// the producer with the same option contract documented by the spec.
export type { RoleTurnTelemetryOptions };

/**
 * Per-live-invocation telemetry context supplied by the host (spec §6). The
 * identity fields are trusted host data; `persist` routes the record through
 * `Host.persistRecord` so it is durable-before-notify (spec §5.5).
 */
export interface RoleTurnProducerContext {
  readonly runId: string;
  readonly role: Role;
  /** Host logical invocation identity (`session.sessionId`). */
  readonly roleSessionId: string;
  /** Physical Pi conversation identity (`conversationId ?? sessionId`). */
  readonly conversationId: string;
  /** Physical Pi session-file identity (a pointer only). */
  readonly sessionFile: string;
  /** Durable-append seam; throws on a malformed / failed append. */
  persist(record: RoleTurnRecord): void;
}

/** Host-observable attachment wired into `attachSessionEventHandler` (spec §6). */
export interface RoleTurnTelemetryAttachment {
  readonly producer: RoleTurnProducer;
  readonly context: RoleTurnProducerContext;
}

/**
 * Run-owned producer / ledger for the additive `role_turn` record.
 *
 * Constructed once per host. Reads the durable `role_turn` stream to seed the
 * next sequence, run/session captured-byte + record-count counters, and
 * per-logical-session identity (spec §7.5). A fresh run has no prior records
 * and starts at sequence 1; a resume restores from durable data and, per the
 * pure reconstruction, validates the run's resolved limit set against the
 * supplied limits — so a resumed host built with mismatched limits throws
 * {@link RoleTurnConfigurationError} before any role session is spawned or
 * Per-live-attachment re-fire dedup that collapses a provider abort's identical
 * re-fired message_end object lives in `attachSessionEventHandler` (spec §6),
 * NOT here. This producer never deduplicates: each `capture` builds and routes
 * one bounded record, so distinct objects with equal content each persist, and
 * an identical object routed through separate live attachments persists once per
 * attachment.
 */
export class RoleTurnProducer {
  private readonly enabled: boolean;
  private readonly limits: RoleTurnTelemetryLimits;
  /** Run this producer owns; a context for a different run is a wiring error. */
  private readonly ownedRunId: string;
  private nextSequence: number;
  private runCapturedBytes: number;
  private runTurns: number;
  private readonly sessions = new Map<string, { bytes: number; turns: number }>();
  /** Immutable per-logical-session identity seen on resume and on captures in this run. */
  private readonly identities = new Map<string, RoleTurnIdentity>();

  constructor(options: {
    readonly runId: string;
    readonly log: RecordLog;
    /** Undefined is the undefined-only default (resolved to enabled + limits below). */
    readonly telemetry: RoleTurnTelemetryOptions | undefined;
  }) {
    const resolved: ResolvedRoleTurnTelemetry = resolveRoleTurnLimits(options.telemetry);
    this.enabled = resolved.enabled;
    this.limits = resolved.limits;
    this.ownedRunId = options.runId;

    // Always reconstruct from the durable v1 stream, even when telemetry is disabled
    // (remediation §3). Reconstruction validates sequence contiguity, per-session
    // identity, counter bounds, and the resolved-limit match, so a prior stream,
    // mismatched limits, or malformed records cannot bypass resume validation just
    // because this host disabled v1. A disabled host still writes no new record
    // (capture returns early on !enabled below). Copy the reconstructed per-session
    // identities into the working map so new captures validate against them.
    const roleTurns = RoleTurnProducer.roleTurnsFromLog(options.log, options.runId);
    const seed = rebuildRoleTurnLedger(roleTurns, this.limits);
    this.nextSequence = seed.nextSequence;
    this.runCapturedBytes = seed.runCapturedBytes;
    this.runTurns = seed.runTurns;
    for (const [roleSessionId, state] of seed.sessions) {
      this.sessions.set(roleSessionId, { bytes: state.bytes, turns: state.turns });
    }
    for (const [roleSessionId, identity] of seed.identity) {
      this.identities.set(roleSessionId, identity);
    }
  }

  /**
   * Reject a repeated `role_session_id` whose identity (role / conversation /
   * session file) changed since a prior record for that invocation (remediation
   * §3 / spec §3.2 / §7.5). Runs before sequence allocation or capture. A fresh
   * invocation (no prior identity) is accepted and its identity is recorded on
   * successful append.
   */
  private assertIdentityMatches(
    roleSessionId: string,
    role: RoleTurnProducerContext["role"],
    conversationId: RoleTurnProducerContext["conversationId"],
    sessionFile: RoleTurnProducerContext["sessionFile"],
  ): void {
    const prior = this.identities.get(roleSessionId);
    if (prior === undefined) return;
    const next: RoleTurnIdentity = {
      role,
      conversationId,
      sessionFile,
    };
    if (
      prior.role !== next.role ||
      prior.conversationId !== next.conversationId ||
      prior.sessionFile !== next.sessionFile
    ) {
      throw new RoleTurnTelemetryLogError(
        `role_turn logical session '${roleSessionId}' identity changed across records (role: ${String(prior.role)} -> ${String(next.role)}, conversation: ${prior.conversationId} -> ${next.conversationId}, file: ${prior.sessionFile} -> ${next.sessionFile})`,
      );
    }
  }

  /** Record the identity of a successfully appended live record (remediation §3). */
  private recordIdentity(context: RoleTurnProducerContext): void {
    this.identities.set(context.roleSessionId, {
      role: context.role,
      conversationId: context.conversationId,
      sessionFile: context.sessionFile,
    });
  }

  /**
   * Capture one eligible assistant `message_end` for the logical session named
   * by `context` (spec §4 / §5.3 / §5.5). Builds one bounded record, routes it
   * through `context.persist`, and advances the run-scoped sequence,
   * run-scoped counters, and session-scoped counters **only after** the append
   * returns successfully. A throw leaves all counters and the sequence
   * unchanged and propagates as the existing host persistence failure.
   */
  capture(context: RoleTurnProducerContext, message: AssistantMessage): void {
    // Fail closed if a live invocation is routed to the wrong run's producer
    // (remediation §3): never mix this producer's sequence and counters across runs.
    // Checked BEFORE the disabled early return so a wiring error is always surfaced,
    // even when telemetry is disabled.
    if (context.runId !== this.ownedRunId) {
      throw new RoleTurnRunMismatchError(
        `role_turn producer for run '${this.ownedRunId}' received a context for run '${context.runId}'`,
      );
    }
    if (!this.enabled) return;

    // Reject a repeated `role_session_id` whose identity changed (remediation §3 /
    // spec §3.2) before allocating a sequence or building the record.
    this.assertIdentityMatches(
      context.roleSessionId,
      context.role,
      context.conversationId,
      context.sessionFile,
    );

    // Record-count suppression: a full scope emits no record, allocates no
    // sequence, and changes no byte/turn counter (spec §5.4).
    if (this.runTurns >= this.limits.max_run_turns) return;
    const session = this.sessions.get(context.roleSessionId);
    if ((session?.turns ?? 0) >= this.limits.max_session_turns) return;

    const candidates = extractRoleTurnCandidates(message);
    const counters: RoleTurnCaptureCounters = {
      sessionBytes: session?.bytes ?? 0,
      runBytes: this.runCapturedBytes,
    };
    const result = buildRoleTurnCapture(candidates, counters, this.limits);

    const sessionBytesAfter = (session?.bytes ?? 0) + result.captured.utf8_bytes;
    const sessionTurnsAfter = (session?.turns ?? 0) + 1;
    const runBytesAfter = this.runCapturedBytes + result.captured.utf8_bytes;
    const runTurnsAfter = this.runTurns + 1;
    const saturated = computeRoleTurnSaturated(
      result.captured,
      result.blocks,
      sessionBytesAfter,
      runBytesAfter,
      sessionTurnsAfter,
      runTurnsAfter,
      this.limits,
    );

    const record: RoleTurnRecord = {
      type: "role_turn",
      schema_version: 1,
      run_id: context.runId,
      role: context.role,
      role_session_id: context.roleSessionId,
      conversation_id: context.conversationId,
      session_file: context.sessionFile,
      sequence: this.nextSequence,
      ts: Date.now(),
      blocks: result.blocks,
      capture: {
        limits: this.limits,
        source: result.source,
        captured: result.captured,
        omitted: result.omitted,
        limit_causes: result.limit_causes,
        saturated,
      },
    };

    // A malformed record or a host persistence failure throws here, leaving
    // every counter and the sequence unchanged (spec §5.5).
    context.persist(record);

    // Only after a successful durable append do we record the identity and advance
    // the counters / sequence (spec §5.5). A failed append above leaves every
    // counter and the sequence unchanged, so the exact same object can be retried
    // with the same (unchanged) sequence. The per-attachment re-fire guard that
    // collapses a provider abort's identical re-fired object lives in
    // `attachSessionEventHandler` (spec §6), not here.
    this.recordIdentity(context);
    this.sessions.set(context.roleSessionId, {
      bytes: sessionBytesAfter,
      turns: sessionTurnsAfter,
    });
    this.runCapturedBytes = runBytesAfter;
    this.runTurns = runTurnsAfter;
    this.nextSequence += 1;
  }

  private static roleTurnsFromLog(log: RecordLog, runId: string): readonly RoleTurnRecord[] {
    // `RecordLog.records` is a typed required member of the interface, so a real
    // `RecordLog` is always supplied (AGENTS.md "no silent fallbacks"). A fresh /
    // historical run simply has no durable v1 records, so the ledger starts at 1
    // and the resume limit check still runs (spec §7.5). A cast double cannot
    // silently disappear here.
    const prior: RoleTurnRecord[] = [];
    for (const record of log.records(runId)) {
      if (record.type !== "role_turn") continue;
      // Fail closed: a durable v1 record must belong to this producer's run (remediation
      // §3). A role_turn with a mismatching run_id indicates a corrupt / cross-run log
      // row and must be rejected rather than silently seed a wrong sequence.
      if (record.run_id !== runId) {
        throw new RoleTurnTelemetryLogError(
          `role_turn for run '${String(record.run_id)}' is not owned by producer run '${runId}'`,
        );
      }
      prior.push(record);
    }
    return prior;
  }
}

/**
 * Map an assistant message's structured `content` into capture-eligible
 * readable candidates in original order (spec §4.1 / §4.2).
 *
 * - `{ type: "text", text }` → one `{ kind: "text", text }` candidate, even
 *   when `text` is `""` (an empty string is still readable content).
 * - Non-redacted `{ type: "thinking", thinking: <non-empty string> }` → one
 *   `{ kind: "thinking", text }` candidate. No Markdown quoting, labels, or
 *   normalization (the display formatter must never be reused here).
 * - Redacted thinking, empty/non-string thinking, and every tool / image /
 *   unknown part is omitted (no signature, count, or reconstruction of it).
 */
export function extractRoleTurnCandidates(
  message: AssistantMessage,
): readonly { readonly kind: "text" | "thinking"; readonly text: string }[] {
  const candidates: { kind: "text" | "thinking"; text: string }[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      // §4.1: the permitted shape is `{ type: "text", text: string }`. A text part
      // whose `text` is not a string is malformed and is omitted — not coerced
      // (never turned into `"0"`, `""`, or thrown), so no raw provider value can
      // enter the durable record (remediation §4).
      if (typeof part.text !== "string") continue;
      candidates.push({ kind: "text", text: part.text });
    } else if (part.type === "thinking") {
      // §4.2: redacted thinking is excluded entirely — no text, no placeholder,
      // no signature, no metric. §4.1: empty / non-string readable thinking is
      // not readable content and is omitted too.
      if (part.redacted || typeof part.thinking !== "string" || part.thinking === "") continue;
      candidates.push({ kind: "thinking", text: part.thinking });
    }
    // Tool call/use, tool result, image, reasoning-signature, unknown, or
    // malformed parts have no v1 representation and are omitted.
  }
  return candidates;
}
