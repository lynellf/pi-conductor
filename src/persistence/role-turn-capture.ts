/**
 * Bounded structured role-turn telemetry — Issue #68.
 *
 * Byte / code-point measurement (§5.2) and the deterministic block / byte
 * limit-application algorithm for one assistant turn (§5.3), plus the
 * post-append `saturated` boundary set (§5.3). Pure, side-effect-free; the
 * pi-coupled content extraction (SDK `content` → capture candidates) lives in
 * `src/host/role-turn-producer.ts`.
 */

import {
  ROLE_TURN_LIMIT_SCOPE_ORDER,
  type RoleTurnBlock,
  type RoleTurnLimitScope,
  type RoleTurnMeasure,
  type RoleTurnSaturatedScope,
  type RoleTurnTelemetryLimits,
  SATURATED_SCOPE_ORDER,
} from "./role-turn-model.js";

// ─── §5.2 Measurements ────────────────────────────────────────────────

const ENCODER = new TextEncoder();

/** UTF-8 byte length per §5.2. */
export function roleTurnUtf8Bytes(value: string): number {
  return ENCODER.encode(value).byteLength;
}

/** Unicode code-point count per §5.2 (not UTF-16 length, not grapheme clusters). */
export function roleTurnCharacterCount(value: string): number {
  return Array.from(value).length;
}

/**
 * Longest original-order sequence of whole Unicode code points whose UTF-8
 * length fits `maxBytes` (§5.2). A surrogate pair / code point is never split;
 * empty or non-positive `maxBytes` yields `""`.
 */
export function roleTurnPrefixWithinBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const codePoint of Array.from(value)) {
    const codePointBytes = roleTurnUtf8Bytes(codePoint);
    if (bytes + codePointBytes > maxBytes) break;
    result += codePoint;
    bytes += codePointBytes;
  }
  return result;
}

// ─── §5.3 limit-application inputs + result ────────────────────────────

/**
 * One capture-eligible readable block (§4.1). No SDK type is carried here so
 * this module stays host-agnostic; `src/host/role-turn-producer.ts` maps SDK
 * content parts into these.
 */
export interface RoleTurnCandidate {
  readonly kind: "text" | "thinking";
  readonly text: string;
}

/** Live counters the §5.3 limit algorithm reads before building one record. */
export interface RoleTurnCaptureCounters {
  /** Cumulative captured bytes already committed to the logical session. */
  readonly sessionBytes: number;
  /** Cumulative captured bytes already committed to the run. */
  readonly runBytes: number;
}

/** The §5.3 deterministic limit-application result for one assistant turn. */
export interface RoleTurnCaptureResult {
  readonly blocks: readonly RoleTurnBlock[];
  readonly source: RoleTurnMeasure;
  readonly captured: RoleTurnMeasure;
  readonly omitted: RoleTurnMeasure;
  readonly limit_causes: readonly RoleTurnLimitScope[];
}

/**
 * Apply the §5.3 deterministic limit algorithm to the candidate blocks of one
 * assistant turn. Takes the logical-session + run cumulative byte counters so
 * the session / run byte allowances are honored; the turn counters start fresh
 * (zero captured bytes / blocks) for this record. Returns the retained blocks
 * and the source / captured / omitted measures plus the actual removal causes.
 */
export function buildRoleTurnCapture(
  candidates: readonly RoleTurnCandidate[],
  counters: RoleTurnCaptureCounters,
  limits: RoleTurnTelemetryLimits,
): RoleTurnCaptureResult {
  let turnCapturedBytes = 0;
  let turnCapturedBlocks = 0;

  const sourceBytes = candidates.reduce((sum, c) => sum + roleTurnUtf8Bytes(c.text), 0);
  const sourceChars = candidates.reduce((sum, c) => sum + roleTurnCharacterCount(c.text), 0);

  const blocks: RoleTurnBlock[] = [];
  let capturedBytes = 0;
  let capturedBlocks = 0;
  let omittedBlocks = 0;
  const limitCauses = new Set<RoleTurnLimitScope>();

  for (const candidate of candidates) {
    const candidateBytes = roleTurnUtf8Bytes(candidate.text);
    const candidateChars = roleTurnCharacterCount(candidate.text);

    // §5.3 step 2: a turn with no retained-block slot drops the candidate
    // (including an empty one) and takes only the `turn` cause.
    if (turnCapturedBlocks >= limits.max_turn_blocks) {
      omittedBlocks += 1;
      limitCauses.add("turn");
      continue;
    }

    // §5.3: effective allowance is the min of the four byte scopes.
    const blockAllowance = limits.max_block_utf8_bytes;
    const turnAllowance = limits.max_turn_utf8_bytes - turnCapturedBytes;
    const sessionAllowance = limits.max_session_utf8_bytes - counters.sessionBytes;
    const runAllowance = limits.max_run_utf8_bytes - counters.runBytes;
    const effective = Math.min(blockAllowance, turnAllowance, sessionAllowance, runAllowance);

    if (candidateBytes <= effective) {
      // §5.3 step 4: the full candidate fits; retain it unchanged.
      blocks.push({
        kind: candidate.kind,
        text: candidate.text,
        original_utf8_bytes: candidateBytes,
        original_characters: candidateChars,
        truncated: false,
        truncated_by: [],
      });
      turnCapturedBytes += candidateBytes;
      turnCapturedBlocks += 1;
      capturedBytes += candidateBytes;
      capturedBlocks += 1;
      continue;
    }

    // §5.3 step 3 / 4: a non-empty candidate exceeds the effective allowance.
    const responsible = responsibleScopes(effective, limits, counters);
    const prefix = roleTurnPrefixWithinBytes(candidate.text, effective);
    if (prefix.length > 0) {
      // At least one complete code point fits: retain the longest fitting prefix.
      blocks.push({
        kind: candidate.kind,
        text: prefix,
        original_utf8_bytes: candidateBytes,
        original_characters: candidateChars,
        truncated: true,
        truncated_by: responsible,
      });
      turnCapturedBytes += roleTurnUtf8Bytes(prefix);
      turnCapturedBlocks += 1;
      capturedBytes += roleTurnUtf8Bytes(prefix);
      capturedBlocks += 1;
      for (const scope of responsible) limitCauses.add(scope);
    } else {
      // No complete code point fits: omit the whole candidate but keep scanning
      // (a later smaller block can still fit without changing source order).
      omittedBlocks += 1;
      for (const scope of responsible) limitCauses.add(scope);
    }
  }

  // captured characters are summed from the actual retained (possibly truncated)
  // block text; omitted bytes / characters fill source - captured so the arithmetic
  // invariant holds for bytes, characters, and blocks alike (§5.2). A truncated
  // block retains a prefix (counted in captured) while its lost bytes land in
  // omitted.bytes; only wholly-absent candidates bump omitted.blocks (§5.2).
  let capturedChars = 0;
  for (const block of blocks) capturedChars += roleTurnCharacterCount(block.text);
  const omittedChars = sourceChars - capturedChars;

  return {
    blocks,
    source: { utf8_bytes: sourceBytes, characters: sourceChars, blocks: candidates.length },
    captured: { utf8_bytes: capturedBytes, characters: capturedChars, blocks: capturedBlocks },
    omitted: {
      utf8_bytes: sourceBytes - capturedBytes,
      characters: omittedChars,
      blocks: omittedBlocks,
    },
    limit_causes: [...limitCauses].sort(
      (a, b) => ROLE_TURN_LIMIT_SCOPE_ORDER.indexOf(a) - ROLE_TURN_LIMIT_SCOPE_ORDER.indexOf(b),
    ),
  };
}

/** Byte scopes tied for the effective minimum, in canonical scope order (§5.3). */
function responsibleScopes(
  effective: number,
  limits: RoleTurnTelemetryLimits,
  counters: RoleTurnCaptureCounters,
): RoleTurnLimitScope[] {
  const allowances: readonly [RoleTurnLimitScope, number][] = [
    ["block", limits.max_block_utf8_bytes],
    ["turn", limits.max_turn_utf8_bytes],
    ["session", limits.max_session_utf8_bytes - counters.sessionBytes],
    ["run", limits.max_run_utf8_bytes - counters.runBytes],
  ];
  return allowances.filter(([, allowance]) => allowance === effective).map(([scope]) => scope);
}

// ─── §5.3 post-append saturation ────────────────────────────────────────

/**
 * Compute the sorted, de-duplicated post-append `saturated` set (§5.3). A named
 * boundary is saturated when the successful append leaves it exactly at its
 * configured maximum (bytes equal max, or a record-count counter reaches its
 * quota). Saturation alone is not an omission claim.
 */
export function computeRoleTurnSaturated(
  captured: RoleTurnMeasure,
  blocks: readonly RoleTurnBlock[],
  sessionBytesAfter: number,
  runBytesAfter: number,
  sessionTurnsAfter: number,
  runTurnsAfter: number,
  limits: RoleTurnTelemetryLimits,
): readonly RoleTurnSaturatedScope[] {
  const saturated = new Set<RoleTurnSaturatedScope>();

  // `block`: any retained block has exactly the per-block maximum.
  if (
    blocks.length > 0 &&
    blocks.some((block) => roleTurnUtf8Bytes(block.text) === limits.max_block_utf8_bytes)
  ) {
    saturated.add("block");
  }

  // `turn`: captured turn bytes or retained turn blocks exactly reached their max.
  if (
    captured.utf8_bytes === limits.max_turn_utf8_bytes ||
    captured.blocks === limits.max_turn_blocks
  ) {
    saturated.add("turn");
  }

  // `session_bytes` / `run_bytes`: cumulative captured bytes equal their max.
  if (sessionBytesAfter === limits.max_session_utf8_bytes) saturated.add("session_bytes");
  if (runBytesAfter === limits.max_run_utf8_bytes) saturated.add("run_bytes");

  // `session_turns` / `run_turns`: successful append reached the record quota.
  if (sessionTurnsAfter === limits.max_session_turns) saturated.add("session_turns");
  if (runTurnsAfter === limits.max_run_turns) saturated.add("run_turns");

  return [...saturated].sort(
    (a, b) => SATURATED_SCOPE_ORDER.indexOf(a) - SATURATED_SCOPE_ORDER.indexOf(b),
  );
}
