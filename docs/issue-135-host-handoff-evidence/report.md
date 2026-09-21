# Report: issue #135 host-materialized bounded handoff evidence

**Issue:** Forgejo #135. **Authority:** the issue's acceptance criteria + the
acknowledged `docs/durable-continuity/spec.md` (v2 host-generated continuity).
**Author:** implementer (Tiel-Coder / Ornith-1.5-35B-A3B variant), Phase 5
(integration, docs, public exports, final repository gate).

This report is the integrated record for the whole feature (Phases 1–5).
Phases 1–4 are each separately reviewed and approved on the host; Phase 5 is the
integration/docs/public-export + full repository gate. The independent **FINAL
REVIEW** below remains a required gate for the reviewer.

---

## 1. What shipped (per phase, repo-relative paths)

| Phase | Work | Key paths |
|---|---|---|
| 1 | Strict opt-in `handoff_evidence:` manifest policy (unknown keys rejected; all keys range-checked; absent block → disabled, byte-identical seed) | `src/manifest/handoff-evidence.ts`, `src/manifest/types.ts`, `src/manifest/parse.ts`, `src/manifest/validate.ts`, `src/manifest/definition.ts`, `src/core/types.ts`, `tests/manifest/handoff-evidence.test.ts` |
| 2 | Durable host-observed record schema — closed TypeBox shape + host-only guards, no model-facing constructor | `src/persistence/handoff-evidence-schema.ts`, `src/persistence/log.ts`, `src/persistence/record-materialization.ts`, `tests/persistence/handoff-evidence-record.test.ts` |
| 3 | Host collection service — read-only git snapshot + bounded execution facts + explicit `unavailable` reasons | `src/host/handoff-evidence/` (index/snapshot/git/redaction/execution/production), host wiring in `loop-fallback.ts` / `loop-session-accepted.ts` / `production-host.ts` / `host.ts`, `tests/host/handoff-evidence-collection.test.ts`, `tests/host/handoff-evidence-production.test.ts` |
| 4 | Pure seed projection at the continuity-materialization boundary, gated on a pinned continuity policy | `src/persistence/handoff-evidence-seed.ts`, `src/persistence/continuity-materialization.ts`, `tests/persistence/handoff-evidence-seed.test.ts`, `tests/host/handoff-evidence-handoff.test.ts` |
| 5 | Public exports + CHANGELOG + full repository gate | `src/index.ts`, `CHANGELOG.md`, `tests/handoff-evidence-public-api.test.ts` |

## 2. Evidence summary (repository gate, all foreground, exit status recorded)

Observed on the host during Phase 5 (run baseline HEAD `39c9274`; the phases are
all uncommitted in the working tree — I touched only `src/index.ts`, this report,
`CHANGELOG.md`, and the one new test):

| Gate | Command | Result | Exit |
|---|---|---|---|
| typecheck | `pnpm typecheck` (tsc `-p tsconfig.test.json`) | clean, 0 errors | 0 |
| build | `pnpm build` (tsc) | emits `dist/` with `.d.ts` | 0 |
| shard 1/4 | `pnpm exec vitest run --shard=1/4` | 1048 passed | 0 |
| shard 2/4 | `pnpm exec vitest run --shard=2/4` | 1096 passed | 0 |
| shard 3/4 | `pnpm exec vitest run --shard=3/4` | 1050 passed (incl. new `tests/handoff-evidence-public-api.test.ts` 5/5) | 0 |
| shard 4/4 | `pnpm exec vitest run --shard=4/4` | 978 passed; `tests/grep-guard.test.ts` 4/4 | 0 |
| focused | `pnpm exec vitest run tests/persistence/handoff-evidence-seed.test.ts tests/host/handoff-evidence-handoff.test.ts tests/handoff-evidence-public-api.test.ts` | 16/16 (7 + 4 + 5) | 0 |
| lint | `pnpm lint` (biome check .) | 948 files, 0 diagnostics | 0 |
| format:check | `pnpm format:check` (biome format .) | 948 files | 0 |
| audit | `pnpm audit` | 3 advisories, **no high/critical** (see §6) | 1 |

Total across the four shards: **4172 tests** (plan's 4167 + 5 for the new
public-api test). The shard-2 non-reproducing failure noted in Phase 4 did not
reproduce this cycle.

## 3. Bounds chosen (Phase 1, enforced through the schema; reviewer-tunable)

- `max_dirty_paths` per snapshot: **64** (`HANDOFF_EVIDENCE_MAX_DIRTY_PATHS`, overflow counted in `omitted.dirty_paths`).
- `max_commands` captured per handoff: **16** (`HANDOFF_EVIDENCE_MAX_COMMANDS`, most-recent-first, overflow counted in `omitted.commands`).
- Command identity: ≤ **512** chars, single-line, redacted (`HANDOFF_EVIDENCE_MAX_COMMAND_IDENTITY_CHARS`).
- Output digest: sha256 (hex, 64 chars) + bounded redacted head ≤ **1024** UTF-8 bytes (`HANDOFF_EVIDENCE_MAX_OUTPUT_HEAD_BYTES`, byte cap enforced in `assertHandoffEvidenceRecord`).
- Seed evidence measured inside the existing `seed_max_utf8_bytes` budget; host-observed block is added after deterministic host observations and before reported narrative, so it is never the first thing dropped silently.

## 4. Deferred items

- **Host verification tool / host re-execution** (issue Decision 3): deferred by design in v1. It would add a new execution-authority surface (side effects, network, cost) — v1 captures facts from the role's *existing* `bash` executions at host interception only.
- **Full-record transport path for operator tooling** beyond the seed reference key (issue Decision 4): the seed carries bounded digests + reference keys; the full bounded record stays in the run-scoped log. A downstream operator view is left to a follow-up.
- **Multi-backend worktree snapshots**: v1 is git-backed (rev-parse HEAD / status --porcelain -z); other SCM backends are out of scope for v1 and produce an explicit `unavailable` marker instead of guessing.
- **Unit tests / behaviour verification of the Phase 3 host-collection service** are intentionally a different review cycle (Phase 3's own review); Phase 5's audit ran the whole suite but does not re-derive the Phase-3 acceptance evidence here.

## 5. Structured self-review

### 5.1 Acceptance criteria

- **Strict opt-in policy; absent → unchanged seed.** `validateHandoffEvidencePolicy` iterates `Object.keys`, rejects unknown keys; all four keys required and range/integer-checked; `Object.freeze` on output; absent block → zero errors and `toMachineDefinition` pins `null`. Seed byte-identity when disabled is tested in `tests/host/handoff-evidence-handoff.test.ts`.
- **Host-observed, distinct from reported claims.** Seed items carry `kind: "host_evidence"` and never carry a continuity finding's `confidence`/`statement` (tested: `Object.keys(item)` contains neither).
- **Host owns collection/provenance/persistence.** No builder/creator on `handoff-evidence-schema.ts`; host-only `handoff_id` via `randomUUID`; single persist-owner in the loop. Model-supplied `handoff_evidence` payload fields are ignored (no promotion) — tested.
- **No silent fallbacks.** Every unobservable fact is an explicit `unavailable` marker with a stable reason code (`non_git_backend`, `git_operation_failed`, `capture_failed`, `redaction_failed`); non-git/no-commit repos produce markers, not states.
- **Bounded + redacted.** Command identity ≤512 chars single-line; output is a sha256 digest + ≤1024-byte redacted head; paths normalized repository-relative; no raw full output / secrets / absolute paths in the seed.
- **Deterministic projection / resume-safe.** `projectHandoffEvidence` is pure over records; replaying the same log reproduces the live item list (tested).
- **Budget stays inside the continuity budget.** Whole seed items are dropped atomically and every drop is counted in `omitted` (never half-admitted, never silent).

### 5.2 Tests

Focused: 16/16 (seed 7 + handoff 4 + public-api 5). Four-shard gate 4172/4172,
`tests/grep-guard.test.ts` 4/4. The new `tests/handoff-evidence-public-api.test.ts`
is RED-first (asserted `isHandoffEvidenceRecord` / `projectHandoffEvidence` are
functions; failed at import before the barrel exports, then 5/5 after).

### 5.3 Architecture

Pure functions first (`handoff-evidence-schema.ts`, `handoff-evidence-seed.ts`,
`src/manifest/handoff-evidence.ts`), host I/O confined to `src/host/handoff-evidence/`
(≤165 LOC per module; well under the ~400 ceiling). `projectHandoffEvidence` is
called solely from `continuity-materialization.ts`, gated on
`continuityRequirements(policy) !== null`. No reducer/FSM/continuity-v2 contract
shape change beyond additive, versioned evidence sections. Named exports only;
JSDoc with spec/issue pointers on public exports.

### 5.4 Security / invariants

- **No model authoring** of observed status/paths/provenance/results.
- **No LLM inference** about test results or contract satisfaction; no parsing of model prose into host facts.
- **No raw full diffs / unrestricted output / secrets / transcripts** in continuity.
- **Grep guard green**: no `@earendil-works/pi-coding-agent` import in
  `src/core`/`src/manifest`/`src/seam`/`src/cost`/`src/persistence`.
- **No silent fallbacks** anywhere in the collection or projection paths.

### 5.5 Scope

In scope: issue #135 v1 across Phases 1–5 (opt-in policy, host collection,
durable record, seed projection, public exports, gate, docs). Out of scope and
intentionally not touched: verification re-execution (deferred), other SCM
backends, downstream operator views, and any reduction/FSM/continuity-v2-shape
change beyond additive evidence sections.

## 6. `pnpm audit` — recorded exactly as observed

Exit 1. Three advisories, all in the **vitest dev toolchain only** (dev-only,
not shipped, and unchanged by this diff — no dependency was touched):

- `esbuild` — arbitrary file read running the dev server on Windows (low, GHSA-g7r4-m6w7-qqqr).
- `vitest` / `@vitest/mocker` — path traversal / arbitrary file read via the redact mock (moderate, GHSA-82fw-gwwq-j7x9).

The repo audit invariant is *no high/critical advisories unaddressed*; all three
are low/moderate dev-tooling advisories, so the bar is met. Exit 1 is recorded as
the exact observed value.

## 7. Host-observed facts vs reported claims (envelope integrity)

**Host-observed (I ran the repo this session):** typecheck exit 0; build exit 0;
shards 1/4=1048, 2/4=1096, 3/4=1050, 4/4=978 (total 4172, grep-guard 4/4 in
shard 4); focused 16/16; lint 948 files/0 diagnostics; format:check exit 0;
`pnpm audit` exit 1 (3 dev-only advisories, no high/critical). The 4 handoff-evidence
phase modules and the new public-api test pass; the only biome fix this cycle was
the new test's import order.

**Reported / untrusted (host directive):** names the phase-1 bugs this issue
addresses and the Phase 4 remediation. The Phase-4 reviewer verdict it carries is
a *reported* `APPROVED` (the original `handoff` envelope transport was degenerate),
corroborated by the host-side shard/focused runs above but **not** treated as an
independent fresh-context approval — hence the Phase 5 FINAL REVIEW gate is
required.

## 8. Remaining risks / open questions

- **One non-reproducing shard-2 failure** appeared in a single Phase-4 run; every
  other shard-2 run passed at 1096. The change is deterministic, so this is
  almost certainly pre-existing flaky behaviour. Suggest re-running `--shard=2/4`
  once more to confirm stability.
- **Audit exit 1** is dev-only; surface only if CI makes `pnpm audit` a hard gate
  (currently the repo bar is no-high/critical).

## 9. Reviewer requested action

`requested_action: verify-and-approve-or-request-changes`. Independently
reproduce the four-shard gate and the focused suite; confirm byte-identity when
no policy is pinned (`renderContinuitySeed` with `{ run_id }` only must not carry
a `host_evidence` section); confirm evidence is projected only when a legacy
continuity policy is pinned; confirm no `@earendil-works/*` import in
`src/core`/`src/manifest`/`src/seam`/`src/cost`/`src/persistence`; confirm the
public exports resolve from `src/index.ts`.
