# Prewalk Slices 0–1 / Checkpoint P1 evidence

**Date:** 2026-09-03

**Scope:** `docs/pi-conductor-prewalk-projection-spec.md`, Build Plan Slices 0 and 1 only

**SDK under test:** `@earendil-works/pi-ai` 0.80.6 and `@earendil-works/pi-coding-agent` 0.80.6

## Provenance and evidence boundary

The committed fixture contains deterministic structural excerpts from private local Pi JSONLs for the exact authorized guide IDs:

- `openai-codex:gpt-5.6-sol` (capture date 2026-08-02)
- `openai-codex:gpt-5.6-terra` (capture date 2026-08-26)
- `openai-codex:gpt-5.6-luna` (capture date 2026-07-12)

A separate real `gpt-5.6-terra` isolated harness capture contains an actual `execution_checkpoint` call and the durably appended result. A separate interrupted real `gpt-5.6-sol` harness capture ends after the checkpoint call and has no result. Source sessions were read only and were not changed.

Scrubbing removed repository/user text, paths, IDs, monetary values, error text, and opaque signature payloads. It retained roles, block types, provider/api/model, stop reasons, numeric token usage, tool names, argument shapes, call/result pairing, signature presence, and empty versus visible thinking. String replacements are ordinal and deterministic. The source paths and credentials are not recorded.

No authorized local real-provider capture contained `thinking.redacted: true` or `toolCall.thoughtSignature`. Those two paths are isolated under `syntheticAugmentation` and are **not fidelity evidence**. The target spec explicitly requires those rows in a captured real-provider transcript, so that acceptance condition is blocked.

Authoritative installed sources inspected before the harness was written:

- `@earendil-works/pi-ai/dist/api/transform-messages.js`
- `@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js`
- `@earendil-works/pi-coding-agent/dist/core/agent-session.js#getContextUsage`

## Transform conformance and repair inventory

All six exact guide/executor pairs produced the same content outcomes for a given guide. Every pair was also accepted by the authenticated oMLX OpenAI-compatible endpoint in a `max_tokens: 1` request after the listed repair policy.

| Guide → executor | Preserved real rows | Lost real rows | ID behavior | Live probe | Unrepairable defects |
| --- | --- | --- | --- | --- | --- |
| sol → `omlx:Qwen3.8-27B-oQ4e-mtp` | 1 user; 1 assistant text; 2 visible-thinking texts; 5 non-error calls and 5 results | 1 signed-empty thinking block; 1 errored assistant turn (including its unresolved call) | forced conformance normalizer remapped all 5 call/result pairs consistently; actual oMLX normalizer retained already-safe IDs | passed | none observed |
| sol → `omlx:Tiel-Coder-35B-A3B-MLX-oQ4e` | same | same | same | passed | none observed |
| terra → `omlx:Qwen3.8-27B-oQ4e-mtp` | 1 user; 1 assistant text; 2 visible-thinking texts; 1 non-error call and result | 1 signed-empty thinking block; 1 errored assistant turn and call | forced remap paired; actual safe ID retained | passed | none observed |
| terra → `omlx:Tiel-Coder-35B-A3B-MLX-oQ4e` | same | same | same | passed | none observed |
| luna → `omlx:Qwen3.8-27B-oQ4e-mtp` | 1 user; 1 visible-thinking text; 6 calls and 6 results | 1 signed-empty thinking block; 1 errored assistant turn | forced remap paired; actual safe IDs retained | passed | none observed |
| luna → `omlx:Tiel-Coder-35B-A3B-MLX-oQ4e` | same | same | same | passed | none observed |

The separate real checkpoint capture preserved the complete scrubbed argument object and its real result for both executors. The interrupted real checkpoint capture caused the SDK to insert `isError: true`, `"No result provided"`.

### Defect classification

| Defect/path | Evidence | Classification | Preflight action |
| --- | --- | --- | --- |
| Signed empty-visible thinking block disappears | real, all guide models | expected loss; repairable only if it empties the enclosing assistant message | drop an enclosing empty assistant message |
| Visible thinking becomes plain assistant text | real, all guide models | expected lossy conversion, not structural failure | record loss counter |
| Errored assistant turn disappears | real, all guide models | expected loss | remove any now-orphaned result |
| Unresolved checkpoint gets synthetic error result | real interrupted harness | repairable | require/re-drive the real checkpoint seal before switch |
| Redacted-only thinking produces an empty assistant message | synthetic structural augmentation only | code path repairable, fidelity unproven | drop empty assistant message |
| `toolCall.thoughtSignature` disappears | synthetic structural augmentation only | expected loss, fidelity unproven | record loss counter |
| Local template rejection | real oMLX probes | not observed | projection fallback if later observed |

No pair had an observed unrepairable transform/template defect. This does **not** satisfy the spec's real redacted/thought-signature acceptance row.

## Token calibration

Provider transcript counts subtract a separately measured system/tool envelope from provider-reported input tokens while retaining base chat-template message framing. `getContextUsage` values are reconstructed exactly from the installed algorithm: last valid guide assistant usage plus `estimateTokens` for trailing source messages. Ten real transcript prefixes per executor family were measured.

| Executor family | n | `estimateTokens` p95 absolute relative error | p95 margin needed to avoid undercount | selected committed margin | `getContextUsage` p95 relative error | Original rule result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Qwen3.8-27B | 10 | 20.13% | 25.20% | **26%** | 3,115.37% | **FAIL under superseded >15% rule** |
| Tiel-Coder-35B | 10 | 20.52% | 25.81% | **26%** | 3,067.59% | **FAIL under superseded >15% rule** |

The oMLX service exposed no dedicated `/tokenize`, `/tokenization`, or `/tokens` endpoint (all returned 404). A `max_tokens: 1` generation returns authoritative provider usage and can validate/count at switch time, but it does not supply the cheap per-turn counter required for forward guide-budget enforcement. Therefore the 26% values are recorded calibration results, not authorization to ignore this kill criterion.

## Prefill measurements

The server was warmed with a one-token request for each model. TTFT is request start to the first generated-content SDK event, not the earlier stream-start event. The 50k selection is ~52.8k by `estimateTokens`; provider framing/tokenization counted ~61k.

| Executor | Requested transformed size | `estimateTokens` | Provider input tokens | TTFT | Budget | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Qwen3.8-27B | ~10k | 9,033 | 9,979 | 6.223s | 10s | PASS |
| Qwen3.8-27B | ~25k | 26,316 | 28,018 | 6.809s | 20s | PASS |
| Qwen3.8-27B | ~50k | 52,831 | 61,176 | 11.780s | 40s | PASS |
| Tiel-Coder-35B | ~10k | 9,033 | 10,205 | 1.203s | 10s | PASS |
| Tiel-Coder-35B | ~25k | 26,316 | 28,244 | 1.438s | 20s | PASS |
| Tiel-Coder-35B | ~50k | 52,831 | 61,402 | 2.721s | 40s | PASS |

A separate ~5k synthetic-content first-after-model-switch microprobe measured Qwen 15.960s then 2.746s on immediate repeat, and Tiel 2.273s then 0.570s. The server reported no explicit model-load duration, so these are first-after-switch totals, not a claim that a process/model load occurred.

## Slice 1: Issue #63 premature ending

The provider-stub regression proves that the implementer's first request inherits both:

1. the planner's terminal handoff result containing `"the loop will end this session"`; and
2. the intervening orchestrator assistant handoff call and its terminal result.

Live disposable-Git-repository trials used the exact configured IDs `openai-codex:gpt-5.6-terra` (planner), `openai-codex:gpt-5.6-sol` (orchestrator), and each authorized oMLX executor. After correcting an invalid harness allowlist (the source registry initially lacked target `write`, correctly producing a non-Issue-63 `host error`), both valid control runs completed, wrote the exact expected file, handed back to the orchestrator, and ended normally.

A controlled Tiel variant changed only the temporary copied `dist/host/tools.js` terminal result to neutral `"emission recorded: handoff → <role>."`. It also completed the exact task. The checkout was not modified.

**Failure classification:** BLOCKED / not reproduced. No valid live trial produced immediate handoff, immediate end, `no_emission`, provider stop, or host error. The invalid preflight trial's host error was caused by the deliberately incorrect tool registry and is excluded from Issue #63 classification. Because both the current text and neutral text succeeded, neutral terminal text neither explains nor disproves the historical failure.

## Kill criteria and Checkpoint P1

| Criterion | Result | Evidence |
| --- | --- | --- |
| Unrepairable pair rejection | PASS for all six pairs | all repaired real-prefix requests accepted; no unrepairable defect observed |
| Every native pair rejects | PASS (did not occur) | six pair/family live coverage |
| p95 estimation error ≤ ~15% or real tokenizer/count endpoint exists | **FAIL for both families** | p95 20.13% / 20.52%; no dedicated count endpoint |
| Warm TTFT within 10s/20s/40s | PASS for both families | table above |
| Real redacted-thinking fidelity row | **BLOCKED** | no authorized real capture; synthetic is not fidelity evidence |
| Real tool `thoughtSignature` fidelity row | **BLOCKED** | no authorized real capture; synthetic is not fidelity evidence |
| Historical premature-ending failure classified | **BLOCKED** | valid controls did not reproduce it |
| Cheaper terminal-text fix fully explains/resolves failure | **UNKNOWN** | control and neutral variant both passed; there was no failure to explain |

Checkpoint predicates:

1. **Slice 0 produced no eliminating kill failure:** **FAIL** for token accounting, and independently **BLOCKED** on two mandatory real-fidelity rows.
2. **Slice 1 showed the failure is not fully explained by a cheaper fix:** **UNKNOWN** because the valid live failure did not reproduce.

# Original P1 result: BLOCKED under the pre-evidence rules

The measurements above are unchanged. Their original adjudication blocked on three requirements that the acknowledged spec subsequently revised: real captures for fields the configured GPT route cannot emit, an automatic tokenizer requirement when absolute p95 error exceeded 15%, and reproduction of an unavailable historical failure.

## Post-evidence adjudication

`docs/pi-conductor-prewalk-projection-spec.md` now makes evidence route-scoped, admits a calibrated one-sided undercount margin up to 35%, and treats a valid non-reproduction as uncertainty rather than proof. Under that contract:

- all configured real guide fields and sealed/interrupted checkpoint behavior are covered;
- redacted thinking and `toolCall.thoughtSignature` remain labeled synthetic SDK-branch coverage, not provider-fidelity evidence;
- both 25.20% / 25.81% one-sided margins round up to an enforced 26%, below the 35% limit;
- all six transform/live probes and both families' TTFT budgets pass; and
- valid Issue #63 trials did not reproduce, so Prewalk is experimental and cannot be claimed as an Issue #63 fix.

# Revised P1: PASS FOR EXPERIMENTAL IMPLEMENTATION

Slice 2 may proceed under the revised spec. Slice 8 remains the binding decision on whether the mechanism provides enough value to ship.
