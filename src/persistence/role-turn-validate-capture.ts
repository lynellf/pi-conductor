/**
 * Bounded structured role-turn telemetry — Issue #68.
 *
 * Strict `role_turn` record validation at persistence boundaries (§7.1). This
 * submodule is the validation entry: {@link assertRoleTurnRecord} orchestrates the
 * record-shape checks and delegates block shape / per-scope caps and the shared
 * primitive validators to `role-turn-validate-blocks.ts`, plus the capture-object
 * arithmetic invariants (`limit_causes`, knowable-saturated reconciliation, measure
 * exactness) it defines here. Pure, side-effect-free. Kept under the ~400 LOC
 * module ceiling by splitting the v1 record's layered validators by responsibility.
 */

import { roleTurnUtf8Bytes } from "./role-turn-capture.js";
import {
  isNonNegativeSafeInteger,
  isPlainObject,
  isPositiveSafeInteger,
  type RoleTurnBlock,
  type RoleTurnLimitScope,
  type RoleTurnMeasure,
  type RoleTurnRecord,
  type RoleTurnSaturatedScope,
  type RoleTurnTelemetryLimits,
  RoleTurnTelemetryLogError,
} from "./role-turn-model.js";
import {
  assertBlockByteCap,
  assertRoleTurnBlocks,
  assertRoleTurnLimitScopeArray,
  assertRoleTurnSaturatedScopeArray,
  assertTurnBlockCap,
  assertTurnByteCap,
  type RoleTurnMeasureArg,
  roleTurnRecomputeCaptured,
} from "./role-turn-validate-blocks.js";
import { assertRoleTurnLimits } from "./role-turn-validate-limits.js";

/**
 * Reject a malformed `role_turn` record before it is retained or read
 * (§7.1). Asserts the record shape so downstream code can trust the narrowed
 * type. Delegates block checks to `role-turn-validate-blocks.ts` and capture
 * arithmetic to this module; see each helper for the invariant it enforces.
 */
export function assertRoleTurnRecord(record: unknown): asserts record is RoleTurnRecord {
  if (!isPlainObject(record)) {
    throw new RoleTurnTelemetryLogError("role_turn record must be a JSON object");
  }
  assertRoleTurnExactKeys(record);

  if (record.type !== "role_turn") {
    throw new RoleTurnTelemetryLogError(
      `role_turn record has unexpected type ${String(record.type)}`,
    );
  }
  if (record.schema_version !== 1) {
    throw new RoleTurnTelemetryLogError(
      `role_turn record has unsupported schema_version ${String(record.schema_version)} (expected 1)`,
    );
  }
  assertPositiveIdentities(record);
  if (!isNonNegativeSafeInteger(record.ts)) {
    throw new RoleTurnTelemetryLogError(
      "role_turn record ts must be a finite non-negative integer",
    );
  }
  if (!isPositiveSafeInteger(record.sequence)) {
    throw new RoleTurnTelemetryLogError("role_turn record sequence must be a positive integer");
  }
  assertRoleTurnBlocks(record.blocks);
  // Re-capture from the validated blocks so the capture arithmetic can be
  // recomputed against the actual retained representation (§5.2 / §7.1).
  assertRoleTurnCapture(record.capture, record.blocks as unknown as readonly RoleTurnBlock[]);
}

/** Enforce exact top-level keys on a validated `role_turn` record. */
function assertRoleTurnExactKeys(record: Record<string, unknown>): void {
  const allowed = new Set([
    "type",
    "schema_version",
    "run_id",
    "role",
    "role_session_id",
    "conversation_id",
    "session_file",
    "sequence",
    "ts",
    "blocks",
    "capture",
  ]);
  const known = new Set(Object.keys(record));
  for (const key of known) {
    if (!allowed.has(key)) {
      throw new RoleTurnTelemetryLogError(`role_turn record has unexpected key '${key}'`);
    }
  }
  for (const key of allowed) {
    if (!(key in record)) {
      throw new RoleTurnTelemetryLogError(`role_turn record is missing required key '${key}'`);
    }
  }
}

/** Enforce non-empty string identities (§3.2 / §3.1). */
function assertPositiveIdentities(record: Record<string, unknown>): void {
  const identities: readonly [unknown, string][] = [
    [record.run_id, "run_id"],
    [record.role, "role"],
    [record.role_session_id, "role_session_id"],
    [record.conversation_id, "conversation_id"],
    [record.session_file, "session_file"],
  ];
  for (const [value, name] of identities) {
    if (typeof value !== "string" || value.length === 0) {
      throw new RoleTurnTelemetryLogError(
        `role_turn record identity '${name}' must be a non-empty string`,
      );
    }
  }
}

/** Enforce exact capture keys and the §5.2 capture arithmetic invariants. */
function assertRoleTurnCapture(capture: unknown, blocks: readonly RoleTurnBlock[]): void {
  if (!isPlainObject(capture)) {
    throw new RoleTurnTelemetryLogError("role_turn record capture must be an object");
  }
  const allowed = new Set(["limits", "source", "captured", "omitted", "limit_causes", "saturated"]);
  const known = new Set(Object.keys(capture));
  for (const key of known) {
    if (!allowed.has(key)) {
      throw new RoleTurnTelemetryLogError(`role_turn capture has unexpected key '${key}'`);
    }
  }
  for (const key of allowed) {
    if (!(key in capture)) {
      throw new RoleTurnTelemetryLogError(`role_turn capture is missing required key '${key}'`);
    }
  }

  const typed = capture as Record<string, unknown>;
  // Validate the limits field exactly (assertRoleTurnLimits below enforces exact
  // keys, positive safe integers, and the bounded-chain inequalities) so
  // `limits` is trustworthy to read.
  assertRoleTurnLimits(typed.limits);
  const limits = typed.limits as RoleTurnTelemetryLimits;
  assertRoleTurnMeasure(typed.source, "source");
  assertRoleTurnMeasure(typed.omitted, "omitted");
  assertRoleTurnLimitScopeArray(typed.limit_causes, "role_turn capture limit_causes");
  assertRoleTurnSaturatedScopeArray(typed.saturated, "role_turn capture saturated");

  // Recompute `captured` from the actually-retained blocks and require the record's
  // reported capture to equal that recomputation (§5.2 / §7.1). The retained block
  // array is the source of truth for what is durable; `captured` must describe it.
  const captured = roleTurnRecomputeCaptured(blocks);
  assertRoleTurnMeasureExact(
    typed.captured as unknown as Record<string, unknown>,
    captured,
    "captured",
  );

  // Enforce the per-block byte cap and the per-turn byte / block caps on the durable
  // record itself (§5.1 / §5.3). Internally-consistent records that exceed these caps
  // (e.g. a block of `max_block_utf8_bytes + 1` retained verbatim, or a turn that
  // captured more bytes / blocks than its resolved caps) must be rejected here, not
  // merely accepted as self-describing. `limits` is already validated and frozen.
  assertBlockByteCap(blocks, limits);
  assertTurnByteCap(captured, limits);
  assertTurnBlockCap(captured, limits);

  // §5.2 arithmetic invariants: source = captured + omitted (bytes, chars, blocks).
  const source = typed.source as RoleTurnMeasure;
  const omitted = typed.omitted as RoleTurnMeasure;
  if (
    captured.utf8_bytes + omitted.utf8_bytes !== source.utf8_bytes ||
    captured.characters + omitted.characters !== source.characters ||
    captured.blocks + omitted.blocks !== source.blocks
  ) {
    throw new RoleTurnTelemetryLogError(
      "role_turn capture measures violate source = captured + omitted",
    );
  }
  // Source bytes/chars must be at least the summed original measures of the retained
  // blocks (§5.2); a truncated block's `original_*` still counts against source. This
  // bounds what could have been retained without authorizing reconstruction.
  const summedOriginalBytes = blocks.reduce(
    (sum, block) => sum + (block.original_utf8_bytes ?? 0),
    0,
  );
  const summedOriginalChars = blocks.reduce(
    (sum, block) => sum + (block.original_characters ?? 0),
    0,
  );
  if (source.utf8_bytes < summedOriginalBytes || source.characters < summedOriginalChars) {
    throw new RoleTurnTelemetryLogError(
      "role_turn source measures may not be below the summed original retained measures",
    );
  }

  // §5.3 local consistency: `limit_causes` reflects only actual removals (never
  // mere saturation) and every truncated block scope is reported. This is the
  // strongest privacy-preserving invariant the representation supports without
  // the prior run/session counters (a single record cannot hold them).
  assertRoleTurnLimitCauses(
    blocks,
    omitted,
    typed.limit_causes as unknown as readonly RoleTurnLimitScope[],
  );

  // §5.3 knowable-saturated reconciliation: the `block` and `turn` boundaries are
  // derivable from this record's retained blocks and turn `captured` alone, so
  // their membership must match exactly. The `session_*` / `run_*` boundaries
  // require the cumulative counters, which a single record cannot carry; those are
  // reconciled on resume by {@link rebuildRoleTurnLedger} (§7.5). A membership
  // mismatch here is corrupt metadata.
  assertRoleTurnSaturatedLocally(
    typed.saturated as unknown as readonly RoleTurnSaturatedScope[],
    typed.captured as unknown as RoleTurnMeasure,
    blocks,
    limits,
  );
}

/** Enforce exact measure keys and non-negative integer fields. */
function assertRoleTurnMeasure(measure: unknown, name: string): void {
  if (!isPlainObject(measure)) {
    throw new RoleTurnTelemetryLogError(`role_turn '${name}' measure must be an object`);
  }
  const allowed = new Set(["utf8_bytes", "characters", "blocks"]);
  const known = new Set(Object.keys(measure));
  for (const key of known) {
    if (!allowed.has(key)) {
      throw new RoleTurnTelemetryLogError(
        `role_turn '${name}' measure has unexpected key '${key}'`,
      );
    }
  }
  for (const key of allowed) {
    if (!(key in measure)) {
      throw new RoleTurnTelemetryLogError(`role_turn '${name}' measure is missing key '${key}'`);
    }
  }
  const typed = measure as Record<string, unknown>;
  for (const key of ["utf8_bytes", "characters", "blocks"] as const) {
    if (!isNonNegativeSafeInteger(typed[key])) {
      throw new RoleTurnTelemetryLogError(
        `role_turn '${name}' measure field '${key}' must be a non-negative integer`,
      );
    }
  }
}

/**
 * Enforce the §5.3 local invariant that `limit_causes` reflects only real
 * removals — never a merely-reached (saturated) boundary — and that every
 * block's `truncated_by` scope is reported as a cause. This is the strongest
 * privacy-preserving, pass/fail check the record can carry without the prior
 * run/session counters (a single record does not hold those cumulative values).
 */
function assertRoleTurnLimitCauses(
  blocks: readonly RoleTurnBlock[],
  omitted: RoleTurnMeasure,
  limitCauses: readonly RoleTurnLimitScope[],
): void {
  // The union of every retained block's `truncated_by` scopes (§5.3): a truncated
  // block always causes a byte removal, so it is always a real removal.
  const truncatedBy = new Set<RoleTurnLimitScope>();
  for (const block of blocks) {
    for (const scope of block.truncated_by) truncatedBy.add(scope);
  }
  // §5.3: a removal is a truncated block OR a wholly absent source block
  // (omitted.blocks > 0), which the producer only ever causes via a byte or
  // turn scope. A byte scope that is merely *full* before the turn is saturation,
  // not a cause — so a non-empty `limit_causes` with no removal is corrupt.
  const removalOccurred = omitted.blocks > 0 || truncatedBy.size > 0;
  if (limitCauses.length > 0 !== removalOccurred) {
    throw new RoleTurnTelemetryLogError(
      "role_turn capture.limit_causes must be non-empty exactly when a block is truncated or a source block is omitted (never mere saturation)",
    );
  }
  // Each truncated block's responsible scope must be surfaced as a cause, so a
  // consumer can always trace why a block was truncated from the metadata alone.
  for (const scope of truncatedBy) {
    if (!limitCauses.includes(scope)) {
      throw new RoleTurnTelemetryLogError(
        "role_turn each block's truncated_by scope must be reflected in limit_causes",
      );
    }
  }
}

/**
 * Reconcile the knowable parts of the post-append `saturated` set locally (§5.3):
 * the `block` and `turn` boundaries are derivable from this record's retained
 * blocks and turn `captured` measures, without the prior run/session counters,
 * so their membership must match exactly. The `session_*` / `run_*` boundaries
 * require the cumulative captured bytes and record counts, which a single record
 * cannot carry; those are reconciled on resume by {@link rebuildRoleTurnLedger}
 * (§7.5). A membership mismatch here is corrupt metadata.
 */
function assertRoleTurnSaturatedLocally(
  saturated: readonly RoleTurnSaturatedScope[],
  captured: RoleTurnMeasure,
  blocks: readonly RoleTurnBlock[],
  limits: RoleTurnTelemetryLimits,
): void {
  const set = new Set(saturated);

  // `block`: any retained block's text length equals the per-block maximum. This
  // matches the producer's own computation exactly (including a retained prefix
  // that happens to land on the maximum), so no valid producer record diverges.
  const blockSaturation =
    blocks.length > 0 &&
    blocks.some((block) => roleTurnUtf8Bytes(block.text) === limits.max_block_utf8_bytes);
  if (set.has("block") !== blockSaturation) {
    throw new RoleTurnTelemetryLogError(
      "role_turn capture.saturated 'block' must match a retained block equal to the per-block maximum",
    );
  }

  // `turn`: captured turn bytes or retained turn blocks exactly reached their
  // per-turn maximum. `session_*` / `run_*` boundaries are intentionally not
  // checked here (they need cumulative counters).
  const turnSaturation =
    captured.utf8_bytes === limits.max_turn_utf8_bytes ||
    captured.blocks === limits.max_turn_blocks;
  if (set.has("turn") !== turnSaturation) {
    throw new RoleTurnTelemetryLogError(
      "role_turn capture.saturated 'turn' must match captured turn bytes/blocks reaching their maximum",
    );
  }
}

/** Enforce a measure has exactly the measure keys, non-negative integers, and equals `expected`. */
function assertRoleTurnMeasureExact(
  measure: Record<string, unknown>,
  expected: RoleTurnMeasureArg,
  name: string,
): void {
  const allowed = ["utf8_bytes", "characters", "blocks"];
  const known = new Set(Object.keys(measure));
  for (const key of known) {
    if (!allowed.includes(key)) {
      throw new RoleTurnTelemetryLogError(
        `role_turn '${name}' measure has unexpected key '${key}'`,
      );
    }
  }
  for (const key of allowed) {
    if (!(key in measure)) {
      throw new RoleTurnTelemetryLogError(`role_turn '${name}' measure is missing key '${key}'`);
    }
  }
  const expectedFlat: Record<string, unknown> = {
    utf8_bytes: expected.utf8_bytes,
    characters: expected.characters,
    blocks: expected.blocks,
  };
  for (const key of allowed as readonly string[]) {
    if (!isNonNegativeSafeInteger(measure[key])) {
      throw new RoleTurnTelemetryLogError(
        `role_turn '${name}' measure field '${key}' must be a non-negative integer`,
      );
    }
  }
  for (const key of allowed as readonly string[]) {
    if (measure[key] !== expectedFlat[key]) {
      throw new RoleTurnTelemetryLogError(
        `role_turn '${name}' measure ${String(key)} does not equal the retained-block measure`,
      );
    }
  }
}
