import { describe, expect, it } from "vitest";

import {
  assertPrewalkRecord,
  materializePrewalkRecord,
  PrewalkRecordError,
  type PrewalkSwitchSelectedRecord,
  type PrewalkValidationRunRecord,
} from "../../src/persistence/prewalk-records.js";

const usage = {
  input: 10,
  output: 2,
  cache_read: 1,
  cache_write: 0,
  tokens: 13,
  cost: 0.25,
} as const;

const checkpoint = {
  outcome: "handoff_to_executor",
  approach: "Implement the pure contract first.",
  rejected_approaches: ["Mutate the reducer."],
  todos: [
    {
      task: "Finish the parser.",
      validation: "pnpm test -- manifest",
      allowed_paths: ["src/manifest/parse.ts"],
      status: "pending",
    },
  ],
  first_edit_path: "src/manifest/parse.ts",
} as const;

const nativeSwitch: PrewalkSwitchSelectedRecord = {
  type: "prewalk_switch_selected",
  schema_version: 1,
  run_id: "run-1",
  role: "implementer",
  role_session_id: "role-session-1",
  transfer_mode: "native",
  guide: {
    model: "openai:gpt-5.6-terra",
    effort: "high",
    provider: "openai-codex",
    api: "responses",
    conversation: { id: "conversation-1", file: "/tmp/guide.jsonl" },
    turns: 3,
  },
  executor: {
    model: "omlx:Qwen3.8-27B-oQ4e-mtp",
    effort: "high",
    provider: "omlx",
    api: "openai-completions",
    system_prompt: "You are the implementer.",
    active_tool_names: ["read", "write", "execution_checkpoint", "handoff"],
    continuation_seed: "Continue the prior guide phase.",
    environment_sha256: "a".repeat(64),
    conversation: { id: "conversation-1", file: "/tmp/guide.jsonl" },
  },
  checkpoint,
  admission: {
    schema_version: 1,
    target_model: "omlx:Qwen3.8-27B-oQ4e-mtp",
    target_context_window: 131_072,
    executor_output_reservation: 8_192,
    executor_envelope_tokens: 4_000,
    safety_margin_tokens: 8_192,
    guide_transcript_budget_tokens: 110_688,
    transformed_tokens: 20_000,
    required_tokens: 40_384,
  },
  preflight: {
    requested_mode: "native",
    ok: true,
    repairs: [],
    rejections: [],
    transformed_message_count: 8,
    transformed_tokens: 20_000,
    reasoning_blocks_dropped: 1,
    thinking_blocks_downgraded: 2,
    assistant_messages_skipped: 0,
    live_probe: "passed",
  },
  guide_usage: usage,
  git_checkpoint: { base_sha: "b".repeat(40), exemplar_sha: "c".repeat(40) },
  ts: 1,
};

describe("Prewalk record validation and materialization", () => {
  it("materializes a valid native selector through canonical JSON", () => {
    const materialized = materializePrewalkRecord(nativeSwitch);
    expect(materialized.record).toEqual(nativeSwitch);
    expect(JSON.parse(materialized.json)).toEqual(nativeSwitch);
    expect(materialized.record).not.toBe(nativeSwitch);
  });

  it("rejects unknown fields instead of retaining unversioned data", () => {
    expect(() =>
      assertPrewalkRecord({
        ...nativeSwitch,
        unversioned: true,
      }),
    ).toThrow(/unknown field/);
  });

  it("rejects unknown nested fields at the persistence boundary", () => {
    expect(() =>
      assertPrewalkRecord({
        ...nativeSwitch,
        guide: { ...nativeSwitch.guide, unversioned: true },
      }),
    ).toThrow(/unknown field/);
  });

  it("rejects projection-only fields on native selectors", () => {
    expect(() =>
      assertPrewalkRecord({
        ...nativeSwitch,
        executor: {
          ...nativeSwitch.executor,
          projection_sha256: "d".repeat(64),
          projection_tokens: 10,
        },
      }),
    ).toThrow(PrewalkRecordError);
  });

  it("requires projection hash and token count for projection selectors", () => {
    const { conversation: _conversation, ...executor } = nativeSwitch.executor;
    expect(() =>
      assertPrewalkRecord({
        ...nativeSwitch,
        transfer_mode: "projection",
        executor,
      }),
    ).toThrow(PrewalkRecordError);
  });

  it("rejects a selector whose admission targets a different executor model", () => {
    expect(() =>
      assertPrewalkRecord({
        ...nativeSwitch,
        admission: { ...nativeSwitch.admission, target_model: "omlx:other" },
      }),
    ).toThrow(/target_model/);
  });

  it("rejects a native selector whose preflight did not authorize native", () => {
    expect(() =>
      assertPrewalkRecord({
        ...nativeSwitch,
        preflight: { ...nativeSwitch.preflight, ok: false },
      }),
    ).toThrow(PrewalkRecordError);
  });

  it("rejects a validation record with a false-done arithmetic mismatch", () => {
    const record: PrewalkValidationRunRecord = {
      type: "prewalk_validation_run",
      schema_version: 1,
      run_id: "run-1",
      role_session_id: "role-session-1",
      results: [
        {
          task: "Finish parser",
          command: "pnpm test -- manifest",
          exit_code: 1,
          claimed_done: true,
        },
      ],
      false_done_count: 0,
      ts: 2,
    };
    expect(() => assertPrewalkRecord(record)).toThrow(/false_done_count/);
  });

  it.each([
    {
      type: "prewalk_executor_seed_delivered",
      schema_version: 1,
      run_id: "run-1",
      role_session_id: "role-session-1",
      conversation_id: "conversation-1",
      continuation_seed_sha256: "d".repeat(64),
      ts: 2,
    },
    {
      type: "prewalk_phase_usage",
      schema_version: 1,
      run_id: "run-1",
      role_session_id: "role-session-1",
      phase: "executor",
      model: "omlx:Qwen3.8-27B-oQ4e-mtp",
      usage,
      turns: 4,
      ts: 2,
    },
    {
      type: "prewalk_validation_run",
      schema_version: 1,
      run_id: "run-1",
      role_session_id: "role-session-1",
      results: [
        {
          task: "Finish parser",
          command: "pnpm test -- manifest",
          exit_code: 0,
          claimed_done: true,
        },
      ],
      false_done_count: 0,
      ts: 2,
    },
    {
      type: "prewalk_switch_failed",
      schema_version: 1,
      run_id: "run-1",
      role_session_id: "role-session-1",
      code: "prewalk_git_checkpoint_failed",
      message: "git commit failed",
      guide_usage: usage,
      git_checkpoint: { base_sha: "b".repeat(40), exemplar_sha: null },
      ts: 2,
    },
  ] as const)("accepts and materializes $type", (record) => {
    expect(materializePrewalkRecord(record).record).toEqual(record);
  });

  it("rejects an unknown prewalk failure code", () => {
    expect(() =>
      assertPrewalkRecord({
        type: "prewalk_switch_failed",
        schema_version: 1,
        run_id: "run-1",
        role_session_id: "role-session-1",
        code: "prewalk_guessed",
        message: "bad",
        guide_usage: usage,
        git_checkpoint: { base_sha: "b".repeat(40), exemplar_sha: null },
        ts: 2,
      }),
    ).toThrow(PrewalkRecordError);
  });
});
