# Durable continuity — parent packet and dispatch cards

Status: **Implementation complete and independently approved at clean HEAD
`3a89948`; overseer end-of-loop review remains pending.** The original packet
below is preserved as dispatch provenance. The acknowledged revision is the
runtime base for DC-HANDOFF, DC-CHILD, and DC-LEDGER.

Prepared repository head: `a3e493e` (pre-spec planning baseline)

Runtime base: the clean commit containing the acknowledged
`docs/durable-continuity/spec.md`, this plan, the manifest, and role prompts.
The acknowledged revision is commit `7641298` on branch
`feature/bubblewrap-execution-spec`; the dispatch base is the commit directly
above it (the current HEAD at time of dispatch). The implementation lead uses
that current clean HEAD as the dispatch base in every child task. Phase 1
contracts (`81fefaf`) and the spec introduction (`bb20a26`) sit on the
linear history below the dispatch base.

## 1. Authoritative inputs

1. `AGENTS.md`
2. `docs/archive/orchestrator-fsm-spec.md`
3. `docs/durable-continuity/spec.md` (must be acknowledged)
4. `docs/durable-continuity/plan.md`
5. This packet
6. Existing transport contracts:
   - `docs/issue-110-handoff-transport.md`
   - `docs/issue-57-minimal-child-protocol.md`
   - `docs/issue-60-context-artifacts/spec.md`

If these inputs disagree, stop and hand back the exact conflict. Do not resolve a
spec conflict silently.

## 2. Fixed implementation decisions

- Continuity policy is opt-in and backward-compatible when omitted.
- Version 1 requires packets only on handoff and successful `report_result`;
  `end` is unchanged.
- One TypeBox schema derives runtime and TypeScript packet types.
- Packet size is measured as UTF-8 bytes after JSON-safe normalization.
- Model-authored packets contain semantic items only. Run/role/visit/child and
  record provenance is host-derived.
- Evaluation outcomes are host-derived from run-local execution records.
- Reducers remain pure and payload-agnostic.
- Existing accepted-handoff and child terminal records are extended additively;
  there is no mutable side store and no migration rewrite.
- Materialization is a pure chronological fold. Supersession is explicit and
  preserves history. No model performs ledger summarization.
- Runtime and children never edit `.okf/`; only deterministic candidate output
  is implemented.
- Fresh FSM roles receive a bounded structured seed. Delegated children receive
  one only through explicit parent-supplied context.

## 3. Shared contract baseline owned by implementation lead

Before dispatch, the lead resolves names and commits these interfaces:

- `ContinuityPolicy` in `src/manifest/types.ts`, parsing in
  `src/manifest/parse.ts`, and static checks in `src/manifest/validate.ts` plus
  the new narrow helper `src/manifest/continuity.ts`;
- `continuityPacketV1Schema`, all item/evidence schemas, and
  `ContinuityPacketV1` derived with `Static<>` in the new
  `src/seam/continuity.ts`, wired into both handoff and `report_result` schemas
  in `src/seam/schema.ts`;
- additive accepted-handoff metadata types in `src/core/types.ts` and the
  optional successful-child continuity sibling in
  `src/persistence/delegation-lifecycle-schema.ts`;
- shared host-side evidence-resolution API in the new
  `src/host/continuity-evidence.ts`, parameterized by run/role/child authority
  and durable artifact/execution/repository lookups so both transport lanes use
  one status vocabulary;
- pure normalization, UTF-8 measurement, envelope/evidence/ledger/seed types,
  and stable diagnostics in the new `src/persistence/continuity.ts`;
- public materializer signatures consumed by host and CLI lanes:
  `materializeContinuity(records, policy)` and
  `renderContinuitySeed(ledger, maxBytes)`;
- red-green contract coverage in new `tests/seam/continuity.test.ts`,
  `tests/manifest/continuity.test.ts`, and
  `tests/persistence/continuity-contract.test.ts`.

Once committed, no child may redesign these signatures. A missing contract
causes a blocked result rather than child-side API invention.

## 4. Dispatch batch

Dispatch all three tasks in one blocking `delegate` call only after the shared
baseline commit is clean. Use `cleanup: delete`. Each `projection_paths` array
must contain the exact paths listed for that lane, plus only the exact shared
contract files created in Phase 1. Do not pass directories or add exploratory
paths.

### Task DC-HANDOFF — handoff-runtime-worker

**Objective:** Persist validated continuity on accepted FSM handoffs and inject
the deterministic bounded seed into fresh FSM role memory.

**Write ownership:**

- `src/core/accepted-handoff.ts`
- `src/core/run-memory.ts`
- `src/host/accepted-handoff-validation.ts`
- `src/host/loop-format.ts`
- `src/host/loop-session-accepted.ts`
- `src/host/loop-session-turn.ts`
- `src/host/run-memory.ts`
- `tests/core/accepted-handoff.test.ts`
- `tests/core/run-memory.test.ts`
- `tests/host/accepted-handoff-validation.test.ts`
- `tests/host/issue-110-handoff-transport.test.ts`
- `tests/host/run-memory.test.ts`

**Read-only context paths:**

- `AGENTS.md`
- `docs/archive/orchestrator-fsm-spec.md`
- `docs/durable-continuity/spec.md`
- `docs/durable-continuity/plan.md`
- `docs/durable-continuity/tasks/parent-packet.md`
- `docs/issue-110-handoff-transport.md`
- `src/core/types.ts`
- `src/seam/schema.ts`
- `src/manifest/types.ts`
- `src/persistence/log.ts`
- `src/persistence/record-materialization.ts`
- `src/host/continuity-evidence.ts`
- the exact shared contract files named by the parent

**Acceptance:** required packets reject before reducer invocation; optional and
legacy handoffs remain valid; accepted packets and evidence status survive a
fresh log read; recipient prompts use one bounded materialized seed and do not
duplicate raw packet prose; focused tests cover Unicode byte boundaries and
spoofed provenance.

**Verification authority:** no shell. Return exact test commands for the parent.

### Task DC-CHILD — child-continuity-worker

**Objective:** Validate, bind, and persist optional/required continuity from
successful delegated `report_result` completions.

**Write ownership:**

- `src/host/delegation/child-observation.ts`
- `src/host/delegation/child-result.ts`
- `src/host/delegation/child-result-mapping.ts`
- `src/host/delegation/child-sdk-tools.ts`
- `src/host/delegation/factory-records.ts`
- `src/host/delegation/scheduler-results.ts`
- `src/persistence/child-completion.ts`
- `tests/host/child-result.test.ts`
- `tests/host/issue-112-legacy-delegate-race.test.ts`
- new focused test files under `tests/host/` whose names begin
  `continuity-child-`
- new focused test files under `tests/persistence/` whose names begin
  `continuity-child-`

**Read-only context paths:**

- `AGENTS.md`
- `docs/archive/orchestrator-fsm-spec.md`
- `docs/durable-continuity/spec.md`
- `docs/durable-continuity/plan.md`
- `docs/durable-continuity/tasks/parent-packet.md`
- `docs/issue-57-minimal-child-protocol.md`
- `docs/issue-60-context-artifacts/spec.md`
- `src/host/delegation/context-artifact-contract.ts`
- `src/host/delegation/context-artifact-admission.ts`
- `src/host/delegation/factory-scheduler.ts`
- `src/host/continuity-evidence.ts`
- `src/persistence/delegation-task.ts`
- `src/persistence/log.ts`
- `src/manifest/types.ts`
- the exact shared contract files named by the parent

**Acceptance:** successful required results without packets become bounded
protocol failures; host provenance cannot be spoofed; child evidence is limited
to granted/run-local authority; terminal records reconstruct after restart;
legacy optional and allowed minimal paths are unchanged; focused tests cover
cancellation/failure exemptions and malformed results.

**Verification authority:** no shell. Return exact test commands for the parent.

### Task DC-LEDGER — continuity-ledger-worker

**Objective:** Implement deterministic ledger/seed materialization, safe
renderers, and the read-only `continuity-report` CLI.

**Write ownership:**

- new `src/persistence/continuity-materialization.ts`
- new `src/persistence/continuity-render.ts`
- new `src/bin/cli-continuity.ts`
- `src/bin/cli-main.ts`
- `src/bin/cli-ui.ts`
- new test files under `tests/persistence/` whose names begin
  `continuity-materialization-`
- new `tests/bin/cli-continuity.test.ts`

**Read-only context paths:**

- `AGENTS.md`
- `docs/archive/orchestrator-fsm-spec.md`
- `docs/durable-continuity/spec.md`
- `docs/durable-continuity/plan.md`
- `docs/durable-continuity/tasks/parent-packet.md`
- `src/bin/cli-reconcile.ts`
- `src/host/log-file.ts`
- `src/persistence/log.ts`
- `src/persistence/record-materialization.ts`
- `src/persistence/trajectory-records.ts`
- the exact shared contract files named by the parent

**Acceptance:** same records produce byte-identical views; explicit
supersession preserves history and rejects bad references; seed priority and
atomic truncation match the spec; Markdown escapes untrusted text; JSON and
candidate output are deterministic; CLI is read-only and exits non-zero on
malformed/unsupported logs.

**Verification authority:** no shell. Return exact test commands for the parent.

## 5. Disjointness

The three lane write lists do not overlap. Shared contract—including
`src/core/types.ts`, `src/seam/schema.ts`, and
`src/persistence/delegation-lifecycle-schema.ts`—manifest parsing, public
barrels, host dependency wiring, documentation, package scripts, and cross-lane
end-to-end tests are parent-only. If a child discovers it must edit a parent or
sibling path, it returns `blocked` with the exact path and reason.
It must not widen its task.

## 6. Required child result fields

Each child calls `report_result` exactly once with:

- `status`: `completed`, or `failed` with a `BLOCKED:` summary when a required
  contract/path is missing (the current tool schema has no `blocked` status);
- concise summary;
- changed files;
- behavior/tests added;
- commands actually run (normally none because children lack shell);
- exact commands recommended to the parent;
- assumptions and unresolved concerns;
- a semantic continuity packet following the acknowledged v1 spec as closely as
  the current runtime permits;
- confirmation that no commit, integration, delegation, or `.okf/` edit occurred.

Because the conductor binary executing this implementation predates the feature,
the current `report_result` schema has no `continuity` field. For this bootstrap
run, append a compact JSON packet after a `CONTINUITY_PACKET_V1:` marker inside
the existing 4,096-character `summary`; keep the full summary within that bound.
The parent extracts and validates it manually. Do not invent a tool argument
rejected by the current runtime.

## 7. Parent integration checks

For each child:

1. inspect durable task/result identity and status;
2. inspect the isolated workspace diff before applying it;
3. compare every changed path to write ownership;
4. validate semantic claims against code and tests;
5. apply only the accepted patch;
6. run focused tests after each lane;
7. record accepted/rejected paths and resulting canonical commit.

Then complete parent-only wiring, docs, public exports, restart E2E coverage,
legacy compatibility coverage, independent review, and the complete gate in the
plan.

## 8. No-run reminder

This packet and its manifest are planning artifacts only. Static manifest
validation is permitted before acknowledgement. Do not run `conduct start`,
`/conduct`, `/conduct:resume`, or any delegation until the overseer acknowledges
the specification and explicitly asks to begin implementation.

## 9. Completion record

- Remediation run: `f4ab4aac-6e7b-4ac5-8bac-9080a6af34e3`.
- Exactly one fresh remediation child: `ecf36bf0`, role
  `child-continuity-worker`, model `MiniMax-M3`. The child supplied the
  substantive delegated-authority regression test; parent production-boundary
  work remains parent-owned.
- Remediation commits: `728a439`, `15e3fa6`, `3fdb605`; documentation closure
  commits: `3a89948` plus the report/plan updates in the current working loop.
- Current reconciliation was `unresolved: []`, `currentProcesses: []`.
- Final read-only independent review of clean HEAD `3a89948`: `APPROVE`.
- Exact verification, audit posture, and the empty OKF-candidate result are in
  `docs/durable-continuity/report.md`.
- No runtime `.okf/` mutation occurred. The only remaining action is the
  overseer's end-of-loop review.
