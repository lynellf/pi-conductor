# Implementation plan: host-generated control and recipient context

Authority: [`spec.md`](./spec.md), acknowledged by the overseer before implementation.
Base SHA containing the acknowledged spec: `3b8262f2cc45e51b3af5be5f86e8d155541795a9`.

## Scope and invariants

- New runs pin continuity schema v2 when `continuity` is omitted.
- Source manifests explicitly selecting v1 are rejected at start; pinned v1 snapshots remain readable/resumable.
- v1 handoff/result records and v1 enrichment records remain readable without reinterpretation.
- `reduce` remains pure and payload-blind; host tools never reduce, persist, spawn, inspect workspaces, or call Jev.
- Accepted control is persisted before checkpoint append; enrichment is persisted before recipient prompting.
- Replay/materialization uses only durable records and pinned policy, never current filesystem, Git, transcript, clock, network, or model state.
- No new dependency and no Pi import in pure layers.

## Dependency graph

```text
v2 policy + schemas + bounded hint/argument helpers
  -> role-aware tool capture/promotion + child terminal normalization
    -> accepted-control durable envelope + v2 observation materializer
      -> mandatory/direct + newest-first deterministic seed + restart/CLI
        -> exact visible-prose capture
          -> v2 Jev candidates, strict replay, durable fallback/ranking
```

## Slice A — minimal control seam

- [x] A1. Add strict v2 continuity policy types, default normalization, and pinned-run migration handling.
- [x] A2. Add role-aware handoff/end/report-result TypeBox schemas, raw JSON/UTF-8 boundary validation, and pure best-effort hint sanitation.
- [x] A3. Promote orchestrator targets, pinned worker returns, authorized `request_end`, and parameterless child results without changing reducer ownership.
- [x] A4. Update shared SDK, RPC, stub, and child tool surfaces plus role-specific no-emission guidance.
- [x] A5. Add Slice A tests for boundary behavior, malformed optional values, raw limit ordering, and existing reducer/lifecycle regressions.

### Gate A

- [x] Focused seam/host/core/delegation tests pass.
- [x] `pnpm typecheck` passes.
- [x] `pnpm build` passes.
- [x] `pnpm lint` and `pnpm format:check` pass.

## Slice B — deterministic observation substrate

- [ ] B1. Add additive `accepted_control` v2 record metadata and strict reader/writer contracts.
- [ ] B2. Add host-derived child terminal observation and bounded evidence projection while retaining compatibility-only legacy status fields.
- [ ] B3. Add pure v2 work-observation materialization from canonical records with stable observation keys, provenance, execution/artifact/workspace bounds, and omission order.
- [ ] B4. Add mandatory/direct-predecessor recipient seed rendering with deterministic newest-first historical admission and exact UTF-8 accounting.
- [ ] B5. Pin default v2 continuity in new run snapshots; reconstruct v2 seeds after restart without ambient I/O.
- [ ] B6. Extend continuity-report JSON/Markdown/OKF-candidate output for v2 while retaining v1 rendering.
- [ ] B7. Add Slice B persistence/host/CLI/restart tests and prove no replay I/O.

### Gate B

- [ ] Focused v2 observation/seed/restart/CLI tests pass.
- [ ] `pnpm typecheck`, `pnpm build`, `pnpm lint`, and `pnpm format:check` pass.

## Slice C — exact visible-prose capture

- [ ] C1. Define bounded `ReportedContextV2` capture and exact tool-call-ID message binding.
- [ ] C2. Wire shared SDK, isolated RPC, and stub transports without substituting nearby/latest prose.
- [ ] C3. Attach exact prose only to accepted v2 control/result context; exclude thinking, tools, images, signatures, errors, and transcript recovery.
- [ ] C4. Add UTF-8/privacy/transport-parity tests.

### Gate C

- [ ] Focused text-capture and privacy tests pass.
- [ ] `pnpm typecheck`, `pnpm build`, `pnpm lint`, and `pnpm format:check` pass.

## Slice D — Jev historical relevance

- [ ] D1. Add v2 candidate projection and fixed Score request state/rubric using existing fixed-origin client infrastructure.
- [ ] D2. Add strict v2 response validation, bounded concurrency/retry, and provider-neutral unavailable fallback.
- [ ] D3. Add durable v2 enrichment records, fingerprints, duplicate/stale replay rejection, and terminal reuse.
- [ ] D4. Rank only optional historical observations; keep task context/direct predecessor mandatory and render atomically under the pinned cap.
- [ ] D5. Add CLI/status diagnostics and disabled/completed/unavailable/restart tests.

### Gate D / completion

- [ ] All Slice D focused tests pass.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm build` passes.
- [ ] `pnpm lint` and `pnpm format:check` pass.
- [ ] `git diff --check` passes.
- [ ] `pnpm test` passes.
- [ ] `pnpm audit --audit-level high` passes or any environment limitation is explicitly reported.
- [ ] Code review completed against correctness, simplicity, architecture, security, and performance.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Existing v1 code assumes semantic handoff fields | Keep v1 types/readers; branch only on pinned v2 policy for new writers. |
| Large loop/host modules exceed the repository ceiling | Add small pure helpers and narrow host seams; avoid broad rewrites. |
| Child status currently controls legacy normalization | Add neutral v2 observation alongside compatibility status; v2 prompts never treat status as authority. |
| Exact prose cannot be proven in one transport | Omit prose rather than guess; control acceptance remains unaffected. |
| Jev failure affects workflow | Persist one unavailable terminal and render deterministic newest-first context. |
| New default breaks legacy unit fixtures | Update only tests whose contract intentionally changes; keep absent-policy compatibility in direct v1 helpers and pinned snapshots. |

## Deliberately not changing

- Reducer transition rules, checkpoint ownership, single-active FSM, or worker-to-worker prohibition.
- Existing v1 packet schemas/readers, v1 pinned-run semantics, trajectory transport, artifact authority, or OKF runtime writes.
- Dependency versions, TypeSafe origin, or external provider configuration.
