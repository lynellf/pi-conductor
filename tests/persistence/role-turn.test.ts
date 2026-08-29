import { describe, expect, it } from "vitest";

import {
  assertRoleTurnRecord,
  buildRoleTurnCapture,
  computeRoleTurnSaturated,
  DEFAULT_ROLE_TURN_LIMITS,
  type RoleTurnBlock,
  type RoleTurnCandidate,
  type RoleTurnCaptureCounters,
  RoleTurnConfigurationError,
  type RoleTurnRecord,
  type RoleTurnTelemetryLimits,
  RoleTurnTelemetryLogError,
  type RoleTurnTelemetryOptions,
  rebuildRoleTurnLedger,
  resolveRoleTurnLimits,
  roleTurnCharacterCount,
  roleTurnPrefixWithinBytes,
  roleTurnUtf8Bytes,
} from "../../src/persistence/role-turn.js";

const DEFAULT_LIMITS: RoleTurnTelemetryLimits = { ...DEFAULT_ROLE_TURN_LIMITS };

function capture(
  candidates: readonly RoleTurnCandidate[],
  counters: RoleTurnCaptureCounters,
  limits: RoleTurnTelemetryLimits = DEFAULT_LIMITS,
) {
  return buildRoleTurnCapture(candidates, counters, limits);
}

// ─── §5.1 resolution ───────────────────────────────────────────────────

describe("resolveRoleTurnLimits", () => {
  it("enabled defaults to true and overlays partial limits on the defaults", () => {
    const resolved = resolveRoleTurnLimits({ limits: { max_block_utf8_bytes: 100 } });
    expect(resolved.enabled).toBe(true);
    expect(resolved.limits.max_block_utf8_bytes).toBe(100);
    expect(resolved.limits.max_turn_utf8_bytes).toBe(DEFAULT_ROLE_TURN_LIMITS.max_turn_utf8_bytes);
  });

  it("enabled becomes false only when explicitly false", () => {
    expect(resolveRoleTurnLimits({ enabled: false }).enabled).toBe(false);
    expect(resolveRoleTurnLimits({}).enabled).toBe(true);
  });

  it("rejects a non-positive limit", () => {
    expect(() => resolveRoleTurnLimits({ limits: { max_turn_blocks: 0 } })).toThrow(
      RoleTurnConfigurationError,
    );
  });

  it("rejects a resolved set that violates the bounded-chain inequalities", () => {
    const bad: RoleTurnTelemetryLimits = { ...DEFAULT_LIMITS, max_block_utf8_bytes: 999_999 };
    expect(() => resolveRoleTurnLimits({ limits: bad })).toThrow(RoleTurnConfigurationError);
  });

  it("rejects a non-integer limit", () => {
    expect(() => resolveRoleTurnLimits({ limits: { max_turn_blocks: 3.5 } })).toThrow(
      RoleTurnConfigurationError,
    );
  });

  it("rejects an unknown config override key", () => {
    expect(() =>
      resolveRoleTurnLimits({ limits: { not_a_limit: 100 } as unknown as RoleTurnTelemetryLimits }),
    ).toThrow(RoleTurnConfigurationError);
  });

  it("rejects unknown top-level telemetry-option keys (allowed: enabled, limits)", () => {
    // A stray top-level field must not silently fall through to default behavior
    // (remediation §1 / spec §5.1). Only `enabled` and `limits` are permitted.
    expect(() =>
      resolveRoleTurnLimits({ bogus: true } as unknown as RoleTurnTelemetryOptions),
    ).toThrow(/unexpected key 'bogus'/);
  });

  it("rejects a limit that is not a safe integer (exceeds MAX_SAFE_INTEGER), not merely non-integer", () => {
    // Number.MAX_SAFE_INTEGER + 1 is a whole-number-valued float: Number.isInteger is
    // true but Number.isSafeInteger is false. The guard must reject it (remediation §1).
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(() => resolveRoleTurnLimits({ limits: { max_turn_blocks: unsafe } })).toThrow(
      RoleTurnConfigurationError,
    );
    // 1e21 is another integer-valued float outside the safe range.
    expect(() => resolveRoleTurnLimits({ limits: { max_session_turns: 1e21 } })).toThrow(
      RoleTurnConfigurationError,
    );
    // A valid safe-integer value at the boundary is accepted.
    expect(() =>
      resolveRoleTurnLimits({ limits: { max_turn_blocks: Number.MAX_SAFE_INTEGER } }),
    ).not.toThrow();
  });

  it("rejects a malformed telemetry option object (non-plain, wrong-typed fields)", () => {
    // Non-plain options (null / array / class instance) must not coerce to default behavior.
    expect(() => resolveRoleTurnLimits(null as unknown as RoleTurnTelemetryOptions)).toThrow(
      RoleTurnConfigurationError,
    );
    expect(() => resolveRoleTurnLimits([] as unknown as RoleTurnTelemetryOptions)).toThrow(
      RoleTurnConfigurationError,
    );
    // Wrong-typed `enabled` is rejected before the limit overlay runs.
    expect(() => resolveRoleTurnLimits({ enabled: "yes" as unknown as boolean })).toThrow(
      /'enabled' must be a boolean/,
    );
    // Wrong-typed `limits` is rejected (not a plain object).
    expect(() =>
      resolveRoleTurnLimits({ limits: "nope" as unknown as Partial<RoleTurnTelemetryLimits> }),
    ).toThrow(/'limits' must be a plain object/);
    // A plain-object option with an unknown limit key still reports the unknown key.
    expect(() =>
      resolveRoleTurnLimits({ limits: { unknown_limit: 1 } as unknown as RoleTurnTelemetryLimits }),
    ).toThrow(/unexpected key 'unknown_limit'/);
  });

  // §5.1 / remediation §1: `isPlainObject` rejects class instances and Date, not
  // just null/array — a prototype-backed object must never be accepted as a plain
  // telemetry option (it would smuggle runtime state into resolveTurnLimits).
  it.each([
    ["null", null],
    ["an array", []],
    ["a Date instance", new Date()],
    ["a class instance", class Foo {}],
  ])("rejects a %s as the telemetry option", (_label, value) => {
    expect(() => resolveRoleTurnLimits(value as unknown as RoleTurnTelemetryOptions)).toThrow(
      RoleTurnConfigurationError,
    );
  });

  it("accepts an empty plain object as the enabled / default configuration", () => {
    // An empty plain object is still plain, so it resolves to enabled + defaults
    // (undefined means default; a class instance would have been rejected above).
    const resolved = resolveRoleTurnLimits({});
    expect(resolved.enabled).toBe(true);
    expect(resolved.limits).toEqual(DEFAULT_ROLE_TURN_LIMITS);
  });

  it("resolves an omitted (undefined) option to enabled + default limits", () => {
    // The public host / factory paths pass `undefined` as the undefined-only default;
    // it must resolve to enabled + defaults, never throw (a `null`/array/Date is
    // rejected as non-plain above). This is what makes `opts.roleTurnTelemetry ??`
    // resolve to `undefined` behave correctly instead of coercing `null` to defaults.
    const resolved = resolveRoleTurnLimits(undefined as unknown as RoleTurnTelemetryOptions);
    expect(resolved.enabled).toBe(true);
    expect(resolved.limits).toEqual(DEFAULT_ROLE_TURN_LIMITS);
  });

  it("prefers the unknown-key error over the positivity error for an unknown key", () => {
    // Ensures an unknown key is reported as unknown, not "not a positive safe integer".
    expect(() =>
      resolveRoleTurnLimits({ limits: { bogus: 0 } as unknown as RoleTurnTelemetryLimits }),
    ).toThrow(/unexpected key 'bogus'/);
  });

  it("accepts a non-default valid partial configuration overlaying defaults", () => {
    const resolved = resolveRoleTurnLimits({
      limits: { max_block_utf8_bytes: 4, max_turn_blocks: 2 },
    });
    expect(resolved.limits.max_block_utf8_bytes).toBe(4);
    expect(resolved.limits.max_turn_blocks).toBe(2);
    // Untouched limits stay at defaults.
    expect(resolved.limits.max_turn_utf8_bytes).toBe(DEFAULT_ROLE_TURN_LIMITS.max_turn_utf8_bytes);
  });
});

// ─── §5.2 measurements ─────────────────────────────────────────────────

describe("measures (§5.2)", () => {
  it("utf8_bytes counts UTF-8 bytes, not UTF-16 length", () => {
    // 'é' is 2 UTF-8 bytes; a 4-byte emoji is 4 UTF-8 bytes.
    expect(roleTurnUtf8Bytes("é")).toBe(2);
    expect(roleTurnUtf8Bytes("😀")).toBe(4);
    expect(roleTurnUtf8Bytes("")).toBe(0);
  });

  it("characterCount counts Unicode code points", () => {
    expect(roleTurnCharacterCount("😀😀a")).toBe(3);
    expect(roleTurnCharacterCount("abc")).toBe(3);
  });

  it("truncation prefix keeps whole code points within the byte allowance", () => {
    // 'ééé' is 6 bytes; 4 bytes fits exactly two 'é' code points, not a third.
    expect(roleTurnPrefixWithinBytes("ééé", 4)).toBe("éé");
    // A 3-byte code point does not fit into a 1-byte allowance: never split.
    expect(roleTurnPrefixWithinBytes("😀", 1)).toBe("");
    expect(roleTurnPrefixWithinBytes("😀", 0)).toBe("");
    // Whole string fits when within the allowance.
    expect(roleTurnPrefixWithinBytes("hello", 10)).toBe("hello");
  });
});

// ─── §5.3 limit application ────────────────────────────────────────────

describe("buildRoleTurnCapture (§5.3)", () => {
  it("retains ordered text + thinking candidates without merging or quoting", () => {
    const result = capture(
      [
        { kind: "text", text: "hello" },
        { kind: "thinking", text: "reasoning" },
        { kind: "text", text: "world" },
      ],
      { sessionBytes: 0, runBytes: 0 },
    );
    expect(result.blocks.map((b) => b.kind)).toEqual(["text", "thinking", "text"]);
    expect(result.blocks.map((b) => b.truncated)).toEqual([false, false, false]);
    expect(result.limit_causes).toEqual([]);
    expect(result.source.blocks).toBe(3);
    expect(result.captured.blocks).toBe(3);
    expect(result.omitted.blocks).toBe(0);
    // Original measures equal retained measures for untruncated blocks.
    expect((result.blocks[0] as RoleTurnBlock).original_utf8_bytes).toBe(5);
  });

  it("keeps an empty text block as a retained empty candidate", () => {
    const result = capture([{ kind: "text", text: "" }], { sessionBytes: 0, runBytes: 0 });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.kind).toBe("text");
    expect((result.blocks[0] as RoleTurnBlock).text).toBe("");
    expect((result.blocks[0] as RoleTurnBlock).original_utf8_bytes).toBe(0);
    expect(result.source.blocks).toBe(1);
    expect(result.captured.blocks).toBe(1);
  });

  it("truncates a single block with the longest fitting whole-code-point prefix", () => {
    // Two 'é' blocks: 4 bytes fit exactly two 'é', dropping the third.
    const result = capture(
      [{ kind: "text", text: "ééé" }],
      { sessionBytes: 0, runBytes: 0 },
      { ...DEFAULT_LIMITS, max_block_utf8_bytes: 4 },
    );
    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0] as RoleTurnBlock;
    expect(block.text).toBe("éé");
    expect(block.truncated).toBe(true);
    expect(block.truncated_by).toEqual(["block"]);
    // Original (3 'é' = 6 bytes / 3 chars) strictly exceeds retained (2 'é' = 4 / 2).
    expect(block.original_utf8_bytes).toBe(6);
    expect(block.original_characters).toBe(3);
    expect(result.captured.utf8_bytes).toBe(4);
    expect(result.captured.characters).toBe(2);
    expect(result.omitted.utf8_bytes).toBe(2);
    expect(result.omitted.blocks).toBe(0); // truncated prefix is not a wholly absent block
    expect(result.limit_causes).toEqual(["block"]);
  });

  it("lists every byte scope tied for the minimum as the truncation cause", () => {
    // block == session == run allowances all equal 3; turn is slack.
    const limits: RoleTurnTelemetryLimits = {
      ...DEFAULT_LIMITS,
      max_block_utf8_bytes: 3,
      max_turn_utf8_bytes: 100,
      max_session_utf8_bytes: 3,
      max_run_utf8_bytes: 3,
    };
    const result = capture(
      [{ kind: "text", text: "abcd" }],
      { sessionBytes: 0, runBytes: 0 },
      limits,
    );
    // 4 bytes > effective 3; the 3-byte prefix "abc" is retained and truncated by the
    // scopes tied for the minimum, in canonical order.
    const block = result.blocks[0] as RoleTurnBlock;
    expect(block.text).toBe("abc");
    expect(block.truncated_by).toEqual(["block", "session", "run"]);
    expect(result.limit_causes).toEqual(["block", "session", "run"]);
    expect(result.captured.utf8_bytes).toBe(3);
  });

  it("omits a non-empty candidate with no complete code point yet keeps scanning", () => {
    // run/session byte budgets already full at 0 remaining; a 1-byte first block
    // is wholly omitted, but a later 1-byte block still fits.
    const limits: RoleTurnTelemetryLimits = {
      ...DEFAULT_LIMITS,
      max_block_utf8_bytes: 100,
      max_session_utf8_bytes: 100,
      max_run_utf8_bytes: 100,
    };
    const result = capture(
      [
        { kind: "text", text: "\u{1F600}x" },
        { kind: "text", text: "a" },
      ],
      { sessionBytes: 0, runBytes: 99 },
      limits,
    );
    expect(result.blocks.map((b) => (b as RoleTurnBlock).text)).toEqual(["a"]);
    expect(result.omitted.blocks).toBe(1);
    expect(result.limit_causes).toEqual(["run"]);
  });

  it("drops every candidate once the turn block quota is exhausted (turn cause)", () => {
    const limits: RoleTurnTelemetryLimits = { ...DEFAULT_LIMITS, max_turn_blocks: 1 };
    const result = capture(
      [
        { kind: "text", text: "a" },
        { kind: "text", text: "b" },
      ],
      { sessionBytes: 0, runBytes: 0 },
      limits,
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.captured.blocks).toBe(1);
    expect(result.omitted.blocks).toBe(1);
    expect(result.limit_causes).toEqual(["turn"]);
  });
});

// ─── §5.3 saturated boundaries ─────────────────────────────────────────

describe("computeRoleTurnSaturated (§5.3)", () => {
  const blocks: RoleTurnBlock[] = [
    {
      kind: "text",
      text: "a",
      original_utf8_bytes: 1,
      original_characters: 1,
      truncated: false,
      truncated_by: [],
    },
  ];

  it("reports block saturation when a retained block equals the per-block maximum", () => {
    const saturated = computeRoleTurnSaturated(
      { utf8_bytes: 5, characters: 5, blocks: 1 },
      [
        {
          ...blocks[0],
          kind: "text",
          text: "-----",
          original_utf8_bytes: 5,
          original_characters: 5,
          truncated: false,
          truncated_by: [],
        },
      ],
      0,
      0,
      1,
      1,
      { ...DEFAULT_LIMITS, max_block_utf8_bytes: 5 },
    );
    expect(saturated).toContain("block");
  });

  it("reports turn/session/run boundaries at their maxima", () => {
    const saturated = computeRoleTurnSaturated(
      {
        utf8_bytes: DEFAULT_LIMITS.max_turn_utf8_bytes,
        characters: 10,
        blocks: DEFAULT_LIMITS.max_turn_blocks,
      },
      blocks,
      DEFAULT_LIMITS.max_session_utf8_bytes,
      DEFAULT_LIMITS.max_run_utf8_bytes,
      DEFAULT_LIMITS.max_session_turns,
      DEFAULT_LIMITS.max_run_turns,
      DEFAULT_LIMITS,
    );
    expect(saturated).toEqual(["turn", "session_bytes", "session_turns", "run_bytes", "run_turns"]);
  });

  it("reports only reached boundaries, in canonical order", () => {
    const saturated = computeRoleTurnSaturated(
      { utf8_bytes: 1, characters: 1, blocks: 1 },
      blocks,
      DEFAULT_LIMITS.max_session_utf8_bytes - 1, // not full
      DEFAULT_LIMITS.max_run_utf8_bytes, // full
      DEFAULT_LIMITS.max_session_turns - 1, // not full
      DEFAULT_LIMITS.max_run_turns, // full
      DEFAULT_LIMITS,
    );
    expect(saturated).toEqual(["run_bytes", "run_turns"]);
  });
});

// ─── §7.1 strict validation ────────────────────────────────────────────

function validRoleTurnRecord(overrides: Partial<RoleTurnRecord> = {}): RoleTurnRecord {
  return {
    type: "role_turn",
    schema_version: 1,
    run_id: "run-1",
    role: "worker",
    role_session_id: "session-1",
    conversation_id: "conv-1",
    session_file: "/tmp/session-1.jsonl",
    sequence: 1,
    ts: 1_700_000_000_000,
    blocks: [
      {
        kind: "text",
        text: "hi",
        original_utf8_bytes: 2,
        original_characters: 2,
        truncated: false,
        truncated_by: [],
      },
    ],
    capture: {
      limits: DEFAULT_LIMITS,
      source: { utf8_bytes: 2, characters: 2, blocks: 1 },
      captured: { utf8_bytes: 2, characters: 2, blocks: 1 },
      omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
      limit_causes: [],
      saturated: [],
    },
    ...overrides,
  };
}

describe("assertRoleTurnRecord (§7.1)", () => {
  it("accepts a valid record whose measures are internally consistent", () => {
    expect(() => assertRoleTurnRecord(validRoleTurnRecord())).not.toThrow();
  });

  it("rejects an unknown top-level key", () => {
    const record = validRoleTurnRecord();
    (record as unknown as Record<string, unknown>).extra = "nope";
    expect(() => assertRoleTurnRecord(record)).toThrow(RoleTurnTelemetryLogError);
  });

  it("rejects an unsupported schema version", () => {
    expect(() =>
      assertRoleTurnRecord(validRoleTurnRecord({ schema_version: 2 as unknown as 1 })),
    ).toThrow(RoleTurnTelemetryLogError);
  });

  it("rejects a non-positive or non-integer sequence", () => {
    expect(() => assertRoleTurnRecord(validRoleTurnRecord({ sequence: 0 }))).toThrow(
      RoleTurnTelemetryLogError,
    );
  });

  it("rejects an empty identity", () => {
    expect(() => assertRoleTurnRecord(validRoleTurnRecord({ role_session_id: "" }))).toThrow(
      RoleTurnTelemetryLogError,
    );
  });

  it("rejects a non-canonical truncated_by array", () => {
    const record = validRoleTurnRecord({
      blocks: [
        {
          kind: "thinking",
          text: "ab",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: true,
          truncated_by: ["run", "block"], // out of canonical order
        },
      ],
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(RoleTurnTelemetryLogError);
  });

  it("rejects a truncated block whose original measures do not exceed retained measures", () => {
    const record = validRoleTurnRecord({
      blocks: [
        {
          kind: "text",
          text: "hello",
          original_utf8_bytes: 5,
          original_characters: 5,
          truncated: true,
          truncated_by: ["block"],
        },
      ],
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(RoleTurnTelemetryLogError);
  });

  it("rejects capture arithmetic that does not satisfy source = captured + omitted", () => {
    const record = validRoleTurnRecord({
      capture: {
        limits: DEFAULT_LIMITS,
        source: { utf8_bytes: 10, characters: 4, blocks: 2 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 3, characters: 1, blocks: 1 },
        limit_causes: [],
        saturated: [],
      },
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(RoleTurnTelemetryLogError);
  });

  it("rejects duplicate keys in the saturated array", () => {
    const record = validRoleTurnRecord({
      capture: {
        limits: DEFAULT_LIMITS,
        source: { utf8_bytes: 2, characters: 2, blocks: 1 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: ["run_turns", "run_turns"],
      },
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(RoleTurnTelemetryLogError);
  });

  it("rejects an unknown block key", () => {
    const record = validRoleTurnRecord({
      blocks: [
        {
          kind: "text",
          text: "hi",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
          bogus: 1,
        } as unknown as RoleTurnBlock,
      ],
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(RoleTurnTelemetryLogError);
  });

  it("rejects an unknown capture.limits key", () => {
    const record = validRoleTurnRecord({
      capture: {
        limits: { ...DEFAULT_LIMITS, extra_limit: 1 } as unknown as RoleTurnTelemetryLimits,
        source: { utf8_bytes: 2, characters: 2, blocks: 1 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(RoleTurnTelemetryLogError);
  });

  it("rejects a persisted limit set that violates the bounded-chain inequalities", () => {
    const record = validRoleTurnRecord({
      capture: {
        limits: { ...DEFAULT_LIMITS, max_block_utf8_bytes: 999_999 },
        source: { utf8_bytes: 2, characters: 2, blocks: 1 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(RoleTurnTelemetryLogError);
  });

  it("rejects when captured.blocks does not equal the retained block count", () => {
    // Base record retains one block; reporting captured.blocks=2 cannot equal the
    // retained block count (recomputed as 1), so this is rejected at retention.
    const record = validRoleTurnRecord({
      capture: {
        limits: DEFAULT_LIMITS,
        source: { utf8_bytes: 2, characters: 2, blocks: 1 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 2 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(RoleTurnTelemetryLogError);
  });

  it("rejects when source measures fall below the summed original retained measures", () => {
    // One retained block with original_utf8_bytes=2000000 but source says only 2.
    const record = validRoleTurnRecord({
      blocks: [
        {
          kind: "text",
          text: "hi",
          original_utf8_bytes: 2_000_000,
          original_characters: 2,
          truncated: true,
          truncated_by: ["block"],
        },
      ],
      capture: {
        limits: DEFAULT_LIMITS,
        source: { utf8_bytes: 2, characters: 2, blocks: 1 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: ["block"],
        saturated: [],
      },
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(RoleTurnTelemetryLogError);
  });

  it("accepts a truncated block whose source >= summed original measures", () => {
    // Two-byte-per-"é" block: original 3 'é' (6 bytes / 3 chars), retained prefix
    // 2 'é' (4 bytes / 2 chars). Source sums the original; omitted fills the rest.
    const record = validRoleTurnRecord({
      blocks: [
        {
          kind: "text",
          text: "éé",
          original_utf8_bytes: 6,
          original_characters: 3,
          truncated: true,
          truncated_by: ["block"],
        },
      ],
      capture: {
        limits: DEFAULT_LIMITS,
        source: { utf8_bytes: 6, characters: 3, blocks: 1 },
        captured: { utf8_bytes: 4, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 2, characters: 1, blocks: 0 },
        limit_causes: ["block"],
        saturated: [],
      },
    });
    expect(() => assertRoleTurnRecord(record)).not.toThrow();
  });

  it("accepts an empty-record blocks[] with zero measures", () => {
    const record = validRoleTurnRecord({
      blocks: [],
      capture: {
        limits: DEFAULT_LIMITS,
        source: { utf8_bytes: 0, characters: 0, blocks: 0 },
        captured: { utf8_bytes: 0, characters: 0, blocks: 0 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
    });
    expect(() => assertRoleTurnRecord(record)).not.toThrow();
  });

  it("rejects a retained block whose UTF-8 bytes exceed the per-block cap", () => {
    // A block retained verbatim with more bytes than max_block_utf8_bytes is an
    // internally consistent record but must be rejected at the persisted boundary.
    const limits: RoleTurnTelemetryLimits = { ...DEFAULT_LIMITS, max_block_utf8_bytes: 3 };
    const record = validRoleTurnRecord({
      capture: { ...validRoleTurnRecord().capture, limits },
      blocks: [
        {
          kind: "text",
          text: "abcd", // 4 bytes > 3
          original_utf8_bytes: 4,
          original_characters: 4,
          truncated: false,
          truncated_by: [],
        },
      ],
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(RoleTurnTelemetryLogError);
  });

  it("rejects captured bytes exceeding the per-turn byte cap", () => {
    const record = validRoleTurnRecord({
      capture: {
        limits: { ...DEFAULT_LIMITS, max_turn_utf8_bytes: 4 },
        // captured.utf8_bytes (5) exceeds max_turn_utf8_bytes for this limit set.
        source: { utf8_bytes: 5, characters: 5, blocks: 1 },
        captured: { utf8_bytes: 5, characters: 5, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
      blocks: [
        {
          kind: "text",
          text: "abcde",
          original_utf8_bytes: 5,
          original_characters: 5,
          truncated: false,
          truncated_by: [],
        },
      ],
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(RoleTurnTelemetryLogError);
  });

  it("rejects captured blocks exceeding the per-turn block cap", () => {
    const limits: RoleTurnTelemetryLimits = { ...DEFAULT_LIMITS, max_turn_blocks: 1 };
    // Two retained blocks but the resolved turn cap is 1 block.
    const record = validRoleTurnRecord({
      capture: {
        limits,
        source: { utf8_bytes: 4, characters: 4, blocks: 2 },
        captured: { utf8_bytes: 4, characters: 4, blocks: 2 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
      blocks: [
        {
          kind: "text",
          text: "ab",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
        },
        {
          kind: "text",
          text: "cd",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
        },
      ],
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(RoleTurnTelemetryLogError);
  });

  it("accepts a record whose captured measures exactly equal the per-turn caps", () => {
    const limits: RoleTurnTelemetryLimits = { ...DEFAULT_LIMITS, max_turn_blocks: 2 };
    // captured.blocks == max_turn_blocks (2) is a genuine `turn` saturation per
    // §5.3, so `saturated` must list it (saturation is not an omission cause,
    // so `limit_causes` stays empty). The untruncated blocks still retain
    // original measures equal to retained measures.
    const record = validRoleTurnRecord({
      capture: {
        limits,
        source: { utf8_bytes: 4, characters: 4, blocks: 2 },
        captured: { utf8_bytes: 4, characters: 4, blocks: 2 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: ["turn"],
      },
      blocks: [
        {
          kind: "text",
          text: "ab",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
        },
        {
          kind: "text",
          text: "cd",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
        },
      ],
    });
    expect(() => assertRoleTurnRecord(record)).not.toThrow();
  });

  // ─── §5.3 limit_causes local consistency ─────────────────────────────

  it("requires limit_causes to be empty when nothing was omitted or truncated", () => {
    // No block truncated, no source block absent: a declared (non-empty) cause is
    // impossible, because it would be a mere saturation, not a removal (§5.3).
    const record = validRoleTurnRecord({
      blocks: [
        {
          kind: "text",
          text: "hi",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
        },
      ],
      capture: {
        limits: DEFAULT_LIMITS,
        source: { utf8_bytes: 2, characters: 2, blocks: 1 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: ["block"],
        saturated: [],
      },
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(
      /limit_causes must be non-empty exactly when a block is truncated/,
    );
  });

  it("accepts limit_causes when a block was truncated by exactly those scopes", () => {
    // One block truncated by the block scope, omitted.blocks=0 but bytes were
    // removed: limit_causes=["block"] is a real removal, not saturation.
    const record = validRoleTurnRecord({
      blocks: [
        {
          kind: "text",
          text: "éé",
          original_utf8_bytes: 6,
          original_characters: 3,
          truncated: true,
          truncated_by: ["block"],
        },
      ],
      capture: {
        limits: DEFAULT_LIMITS,
        source: { utf8_bytes: 6, characters: 3, blocks: 1 },
        captured: { utf8_bytes: 4, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 2, characters: 1, blocks: 0 },
        limit_causes: ["block"],
        saturated: [],
      },
    });
    expect(() => assertRoleTurnRecord(record)).not.toThrow();
  });

  it("rejects a block whose truncated_by scope is not reflected in limit_causes", () => {
    // A block truncated by the session scope but reported with an empty
    // limit_causes cannot be trusted: the cause is missing from the metadata.
    // `original_*` strictly exceeds the retained measures so it passes the block
    // shape check and reaches the limit_causes check.
    const record = validRoleTurnRecord({
      blocks: [
        {
          kind: "thinking",
          text: "abcd",
          original_utf8_bytes: 10,
          original_characters: 8,
          truncated: true,
          truncated_by: ["session"],
        },
      ],
      capture: {
        limits: DEFAULT_LIMITS,
        source: { utf8_bytes: 10, characters: 8, blocks: 1 },
        captured: { utf8_bytes: 4, characters: 4, blocks: 1 },
        omitted: { utf8_bytes: 6, characters: 4, blocks: 0 },
        limit_causes: ["block"],
        saturated: [],
      },
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(/must be reflected in limit_causes/);
  });

  it("accepts turn cause with omitted.blocks but no truncated block", () => {
    // Turn block-slot exhaustion omits whole source blocks (omitted.blocks>0) with
    // the turn cause and leaves no truncated block. This is a real removal, so
    // `limit_causes` = ["turn"]. captured.blocks reaches max_turn_blocks, so the
    // record is also `turn` saturated (saturation is not an omission cause).
    const record = validRoleTurnRecord({
      capture: {
        limits: { ...DEFAULT_LIMITS, max_turn_blocks: 1 },
        source: { utf8_bytes: 4, characters: 4, blocks: 2 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 2, characters: 2, blocks: 1 },
        limit_causes: ["turn"],
        saturated: ["turn"],
      },
      blocks: [
        {
          kind: "text",
          text: "ab",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
        },
      ],
    });
    expect(() => assertRoleTurnRecord(record)).not.toThrow();
  });

  // ─── §5.3 knowable saturated reconciliation ──────────────────────────

  it("requires 'block' in saturated to match a retained block equal to the per-block maximum", () => {
    // No retained block equals the per-block maximum, so 'block' is a false claim.
    const record = validRoleTurnRecord({
      blocks: [
        {
          kind: "text",
          text: "hi",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
        },
      ],
      capture: {
        limits: { ...DEFAULT_LIMITS, max_block_utf8_bytes: 5 },
        source: { utf8_bytes: 2, characters: 2, blocks: 1 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: ["block"],
      },
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(/saturated 'block'/);
  });

  it("requires a retained block equal to the per-block maximum to report 'block' saturation", () => {
    // One retained block is exactly the per-block maximum: the producer sets
    // `block` saturated (§5.3), so an empty saturated set is corrupt.
    const record = validRoleTurnRecord({
      blocks: [
        {
          kind: "text",
          text: "abcde",
          original_utf8_bytes: 5,
          original_characters: 5,
          truncated: false,
          truncated_by: [],
        },
      ],
      capture: {
        limits: { ...DEFAULT_LIMITS, max_block_utf8_bytes: 5 },
        source: { utf8_bytes: 5, characters: 5, blocks: 1 },
        captured: { utf8_bytes: 5, characters: 5, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(/saturated 'block'/);
  });

  it("requires 'turn' in saturated to match captured turn bytes/blocks reaching their maximum", () => {
    // captured.blocks reaches max_turn_blocks, so 'turn' must be listed even though
    // no byte was removed (saturation is not an omission cause).
    const record = validRoleTurnRecord({
      capture: {
        limits: { ...DEFAULT_LIMITS, max_turn_blocks: 1 },
        source: { utf8_bytes: 2, characters: 2, blocks: 1 },
        captured: { utf8_bytes: 2, characters: 2, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: ["run_turns"],
      },
      blocks: [
        {
          kind: "text",
          text: "ab",
          original_utf8_bytes: 2,
          original_characters: 2,
          truncated: false,
          truncated_by: [],
        },
      ],
    });
    expect(() => assertRoleTurnRecord(record)).toThrow(/saturated 'turn'/);
  });
});

describe("resolveRoleTurnLimits + assertRoleTurnRecord — safe-integer boundary table (remediation §1)", () => {
  it.each([
    ["positive safe integer at MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER, true],
    ["exceeds MAX_SAFE_INTEGER by 1", Number.MAX_SAFE_INTEGER + 1, false],
    ["large float-valued number", 1e21, false],
    ["negative safe integer", -1, false],
    ["zero is not a positive safe integer", 0, false],
  ])("resolveRoleTurnLimits treats %s as limit max_turn_blocks", (_label, value, shouldAccept) => {
    const run = () => resolveRoleTurnLimits({ limits: { max_turn_blocks: value as number } });
    if (shouldAccept) expect(run).not.toThrow();
    else expect(run).toThrow(RoleTurnConfigurationError);
  });
});

// ─── §7.5 reconstruction ───────────────────────────────────────────────

describe("rebuildRoleTurnLedger (§7.5)", () => {
  function turn(sequence: number, overrides: Partial<RoleTurnRecord> = {}): RoleTurnRecord {
    return validRoleTurnRecord({
      sequence,
      role_session_id: "s1",
      conversation_id: "c1",
      session_file: "/tmp/s1.jsonl",
      blocks: [
        {
          kind: "text",
          text: "x",
          original_utf8_bytes: 1,
          original_characters: 1,
          truncated: false,
          truncated_by: [],
        },
      ],
      capture: {
        limits: DEFAULT_LIMITS,
        source: { utf8_bytes: 1, characters: 1, blocks: 1 },
        captured: { utf8_bytes: 1, characters: 1, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
      ...overrides,
    });
  }

  it("reconstructs next sequence, run counters, session state, and identity from a valid stream", () => {
    const rebuild = rebuildRoleTurnLedger([turn(1), turn(2), turn(3)], DEFAULT_LIMITS);
    expect(rebuild.nextSequence).toBe(4);
    expect(rebuild.runTurns).toBe(3);
    expect(rebuild.runCapturedBytes).toBe(3);
    expect(rebuild.sessions.get("s1")).toEqual({ bytes: 3, turns: 3 });
    expect(rebuild.identity.get("s1")).toEqual({
      role: "worker",
      conversationId: "c1",
      sessionFile: "/tmp/s1.jsonl",
    });
  });

  it("starts at next sequence 1 with no prior records", () => {
    const rebuild = rebuildRoleTurnLedger([], DEFAULT_LIMITS);
    expect(rebuild.nextSequence).toBe(1);
    expect(rebuild.runTurns).toBe(0);
    expect(rebuild.sessions.size).toBe(0);
  });

  it("throws on a non-contiguous sequence", () => {
    expect(() => rebuildRoleTurnLedger([turn(1), turn(3)], DEFAULT_LIMITS)).toThrow(
      RoleTurnTelemetryLogError,
    );
  });

  it("throws when a record's recorded saturated set does not match its reconstructed counters", () => {
    // A single record (run_turns not yet full) reconstructs an empty saturated set;
    // recording run_turns there is an inconsistent invariant and must be rejected.
    const finalTurn = turn(1, {
      capture: {
        limits: DEFAULT_LIMITS,
        source: { utf8_bytes: 1, characters: 1, blocks: 1 },
        captured: { utf8_bytes: 1, characters: 1, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: ["run_turns"],
      },
    });
    expect(() => rebuildRoleTurnLedger([finalTurn], DEFAULT_LIMITS)).toThrow(
      RoleTurnTelemetryLogError,
    );
  });

  it("throws when a record carries limits that differ from the resolved set", () => {
    const otherLimits: RoleTurnTelemetryLimits = { ...DEFAULT_LIMITS, max_run_turns: 400 };
    const mismatch = turn(1, {
      capture: {
        limits: otherLimits,
        source: { utf8_bytes: 1, characters: 1, blocks: 1 },
        captured: { utf8_bytes: 1, characters: 1, blocks: 1 },
        omitted: { utf8_bytes: 0, characters: 0, blocks: 0 },
        limit_causes: [],
        saturated: [],
      },
    });
    expect(() => rebuildRoleTurnLedger([mismatch], DEFAULT_LIMITS)).toThrow(
      RoleTurnConfigurationError,
    );
  });
});
