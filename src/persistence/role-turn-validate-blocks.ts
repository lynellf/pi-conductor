/**
 * Bounded structured role-turn telemetry — Issue #68.
 *
 * Strict `role_turn` record validation at persistence boundaries (§7.1). This
 * submodule owns the block-level checks and the shared primitive validators
 * (exact keys, ordered scope arrays, per-scope caps) plus the retained-block
 * measure recomputation. The entry point lives in `role-turn-validate.ts`; the
 * capture-arithmetic checks live in `role-turn-validate-capture.ts`. Pure,
 * side-effect-free. Kept under the ~400 LOC module ceiling by splitting the v1
 * record's layered validators by responsibility.
 */

import { roleTurnCharacterCount, roleTurnUtf8Bytes } from "./role-turn-capture.js";
import {
  isNonNegativeSafeInteger,
  isPlainObject,
  ROLE_TURN_LIMIT_SCOPE_ORDER,
  type RoleTurnBlock,
  type RoleTurnTelemetryLimits,
  RoleTurnTelemetryLogError,
  SATURATED_SCOPE_ORDER,
} from "./role-turn-model.js";

/**
 * Assert that `object` has exactly the `allowed` keys (no extras, no missing).
 * Prevents a cast from smuggling raw provider / tool data into an append-only log
 * (§7.1). `kind` is described only for clearer error messages. Shared primitive
 * imported by both the block and capture submodules.
 */
export function assertExactKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  kind: string,
): void {
  const known = new Set(Object.keys(object));
  for (const key of known) {
    if (!allowed.includes(key)) {
      throw new RoleTurnTelemetryLogError(`${kind} has unexpected key '${key}'`);
    }
  }
  for (const key of allowed) {
    if (!(key in object)) {
      throw new RoleTurnTelemetryLogError(`${kind} is missing required key '${key}'`);
    }
  }
}

/**
 * Capture-measure shape accepted by the per-turn cap helpers (§5.2). Narrowed to
 * exactly the fields those helpers read so they can be shared across submodules.
 */
export interface RoleTurnMeasureArg {
  readonly utf8_bytes: number;
  readonly characters: number;
  readonly blocks: number;
}

/** Enforce that every retained block fits its per-block byte cap (§5.1 / §5.3). */
export function assertBlockByteCap(
  blocks: readonly RoleTurnBlock[],
  limits: RoleTurnTelemetryLimits,
): void {
  for (const block of blocks) {
    const bytes = roleTurnUtf8Bytes(block.text);
    if (bytes > limits.max_block_utf8_bytes) {
      throw new RoleTurnTelemetryLogError(
        `role_turn block retains ${bytes} bytes, exceeding the per-block cap of ${limits.max_block_utf8_bytes}`,
      );
    }
  }
}

/** Enforce that the turn's captured bytes fit the per-turn byte cap (§5.1 / §5.3). */
export function assertTurnByteCap(
  captured: RoleTurnMeasureArg,
  limits: RoleTurnTelemetryLimits,
): void {
  if (captured.utf8_bytes > limits.max_turn_utf8_bytes) {
    throw new RoleTurnTelemetryLogError(
      `role_turn capture exceeds the per-turn byte cap: ${captured.utf8_bytes} > ${limits.max_turn_utf8_bytes}`,
    );
  }
}

/** Enforce that the turn's captured blocks fit the per-turn block cap (§5.1 / §5.3). */
export function assertTurnBlockCap(
  captured: RoleTurnMeasureArg,
  limits: RoleTurnTelemetryLimits,
): void {
  if (captured.blocks > limits.max_turn_blocks) {
    throw new RoleTurnTelemetryLogError(
      `role_turn capture exceeds the per-turn block cap: ${captured.blocks} > ${limits.max_turn_blocks}`,
    );
  }
}

/** Enforce block shape, per-block measure arithmetic, and truncated/truncated_by pairing. */
export function assertRoleTurnBlocks(blocks: unknown): void {
  if (!Array.isArray(blocks)) {
    throw new RoleTurnTelemetryLogError("role_turn record blocks must be an array");
  }
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as unknown;
    if (!isPlainObject(block)) {
      throw new RoleTurnTelemetryLogError(`role_turn block at index ${index} must be an object`);
    }
    assertExactKeys(
      block,
      ["kind", "text", "original_utf8_bytes", "original_characters", "truncated", "truncated_by"],
      `role_turn block at index ${index}`,
    );
    // Narrow to the validated block shape once the plain-object guard passes.
    const typed = block as unknown as RoleTurnBlock;
    const kind = typed.kind;
    if (kind !== "text" && kind !== "thinking") {
      throw new RoleTurnTelemetryLogError(
        `role_turn block at index ${index} has invalid kind ${String(kind)}`,
      );
    }
    if (typeof typed.text !== "string") {
      throw new RoleTurnTelemetryLogError(
        `role_turn block at index ${index} text must be a string`,
      );
    }
    if (!isNonNegativeSafeInteger(typed.original_utf8_bytes)) {
      throw new RoleTurnTelemetryLogError(
        `role_turn block at index ${index} original_utf8_bytes must be a non-negative integer`,
      );
    }
    if (!isNonNegativeSafeInteger(typed.original_characters)) {
      throw new RoleTurnTelemetryLogError(
        `role_turn block at index ${index} original_characters must be a non-negative integer`,
      );
    }
    if (typeof typed.truncated !== "boolean") {
      throw new RoleTurnTelemetryLogError(
        `role_turn block at index ${index} truncated must be a boolean`,
      );
    }
    assertRoleTurnLimitScopeArray(
      typed.truncated_by,
      `role_turn block at index ${index} truncated_by`,
    );

    const retainedBytes = roleTurnUtf8Bytes(typed.text);
    const retainedChars = roleTurnCharacterCount(typed.text);
    const truncated = typed.truncated;

    // truncated_by is non-empty iff the block is truncated (§5.3).
    if (truncated !== typed.truncated_by.length > 0) {
      throw new RoleTurnTelemetryLogError(
        `role_turn block at index ${index} truncated must match a non-empty truncated_by`,
      );
    }

    if (truncated) {
      if (
        typed.original_utf8_bytes <= retainedBytes ||
        typed.original_characters <= retainedChars
      ) {
        throw new RoleTurnTelemetryLogError(
          `role_turn block at index ${index} truncated original measures must exceed retained measures`,
        );
      }
    } else if (
      typed.original_utf8_bytes !== retainedBytes ||
      typed.original_characters !== retainedChars
    ) {
      throw new RoleTurnTelemetryLogError(
        `role_turn block at index ${index} untruncated original measures must equal retained measures`,
      );
    }
  }
}

/** Enforce an ordered, de-duplicated scope array in canonical order (§3.1). */
export function assertRoleTurnLimitScopeArray(value: unknown, name: string): void {
  assertOrderedScopeArray(value, name, ROLE_TURN_LIMIT_SCOPE_ORDER);
}

/** Enforce an ordered, de-duplicated saturated scope array in canonical order (§3.1). */
export function assertRoleTurnSaturatedScopeArray(value: unknown, name: string): void {
  assertOrderedScopeArray(value, name, SATURATED_SCOPE_ORDER);
}

/**
 * Assert a value is an ordered (strictly increasing index), de-duplicated array
 * of known scopes in canonical order (§3.1). `order` is the canonical scope
 * ordering shared by the limit-scope and saturated-scope arrays.
 */
function assertOrderedScopeArray(value: unknown, name: string, order: readonly string[]): void {
  if (!Array.isArray(value)) {
    throw new RoleTurnTelemetryLogError(`${name} must be an array`);
  }
  let lastIndex = -1;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !order.includes(item)) {
      throw new RoleTurnTelemetryLogError(`${name} must contain only known scopes`);
    }
    if (seen.has(item)) {
      throw new RoleTurnTelemetryLogError(`${name} must not contain duplicate scopes`);
    }
    const index = order.indexOf(item);
    if (index <= lastIndex) {
      throw new RoleTurnTelemetryLogError(`${name} must be in canonical order`);
    }
    lastIndex = index;
    seen.add(item);
  }
}

/** Recompute the `captured` measure directly from the retained blocks (§5.2). */
export function roleTurnRecomputeCaptured(blocks: readonly RoleTurnBlock[]): RoleTurnMeasureArg {
  let utf8Bytes = 0;
  let characters = 0;
  for (const block of blocks) {
    utf8Bytes += roleTurnUtf8Bytes(block.text);
    characters += roleTurnCharacterCount(block.text);
  }
  return { utf8_bytes: utf8Bytes, characters, blocks: blocks.length };
}
