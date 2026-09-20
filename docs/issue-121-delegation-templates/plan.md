# Implementation plan: issue #121 manifest-defined delegation assignments

Status: implementation complete; final repository review and commit are pending.

Authority: issue #121, [`docs/delegation.md`](../delegation.md), and the pinned-manifest / host-authority invariants in [`docs/archive/orchestrator-fsm-spec.md`](../archive/orchestrator-fsm-spec.md).

## Outcome

Replace the default model-facing `delegate` submission union with two small tools:

```ts
delegate_task({
  assignment: "p1-review-remediation",
  brief: "Fix the documented required-path validation defects."
})

delegation_control({
  operation: "status",
  child_ids: ["…"]
})
```

One `delegate_task` call resolves one pinned manifest assignment into one internal child task. The host continues to own policy resolution, admission, persistence, scheduling, spawning, cost, cleanup, and recovery. Existing external and pinned-run consumers of the general `delegate` contract retain a versioned legacy path during migration.

## Proposed contract decisions

These decisions make the plan implementable but require overseer acknowledgement in the focused specification created by Task 1.

1. **Explicit protocol selection.** Add `delegation.interface: assignments_v1 | legacy_v1`. Existing manifests and pinned snapshots that omit it retain `legacy_v1`; new documentation and examples use `assignments_v1`. There is no silent reinterpretation of an old manifest.
2. **Assignment location.** Assignment templates live in the parent role's `delegation.assignments` list because they bind parent authority. `allowed_subagents`, child/concurrency limits, context-artifact limits, and trusted `mode` remain role-level policy.
3. **Assignment shape.** Each assignment declares:
   - `name` — also used as the host-resolved task ID;
   - `subagent` — selects the pinned profile, whose model, prompt, execution backend, and cost cap remain authoritative;
   - `expected_output` — the fixed output contract;
   - optional exact `projection_paths`, `tools`, and `verification_recipe` — trusted narrowing only.
4. **Dynamic model input.** `delegate_task` accepts only closed `{ assignment, brief }` arguments. `brief` is a non-whitespace string bounded to 8,192 characters and becomes the internal task objective. No task array, ID, mode, profile, expected-output, projection, tool, recipe, or context-artifact field is model-supplied.
5. **One child per submission.** The resolver emits one existing internal `DelegateSubmissionArgs` task. Reusing an assignment in a later tool call is allowed; child IDs remain the durable unique handles.
6. **Mode remains trusted policy.** The existing pinned role-level `delegation.mode` determines blocking/nonblocking behavior. A nonblocking submission returns `{ child_id }`; a blocking submission returns `{ child_id, result }`. Both expose the child ID, and lifecycle operations are available only through `delegation_control`.
7. **Shared admission core.** Assignment resolution feeds the existing validation/preparation/scheduler path. Controller-native delegation and deprecated external programmatic callers may continue to submit the general internal task shape; they do not become part of the new model-visible schema.
8. **No new reducer state.** Assignments remain host-only manifest data. They are included in the existing immutable manifest snapshot but not `MachineDefinition`, checkpoints, or FSM events.
9. **No new acceptance record unless tests prove it necessary.** The existing atomic `delegation_submission_accepted` record is sufficient when the resolved one-task request and child authority fingerprints are deterministic. The assignment name is the task ID, the raw brief participates in existing request fingerprints, and the pinned snapshot retains the template. If this cannot prove replay/idempotency without ambiguity, Task 6 must stop and propose a versioned record addition rather than weakening validation.
10. **Legacy tool is not model-visible in assignment mode.** `assignments_v1` roles receive `delegate_task` and `delegation_control`, not `delegate`. `legacy_v1` roles continue to receive only the current `delegate` tool and union schema until its announced removal window.

## Scope and invariants

- The model cannot widen profile, model, workspace, projection, tool, recipe, mode, cost, or child-count authority through tool arguments.
- Static manifest checks reject malformed and cross-reference-invalid assignments before a role session starts.
- Runtime admission still rechecks Git cleanliness, materialized paths, sandbox availability, budget, parent lifecycle, and live limits.
- One submission is persisted before its child is queued and returns exactly one stable child ID.
- Multiple accepted nonblocking submissions share the existing scheduler and may run concurrently up to `max_parallel`.
- Resume never resubmits unfinished accepted children; existing cancellation/reconciliation rules remain authoritative.
- TypeBox remains the single schema source at SDK, RPC, and validation boundaries.
- `src/core`, `src/manifest`, `src/seam`, `src/cost`, and `src/persistence` remain free of Pi imports.
- No `ctx.newSession()` or `ctx.fork()` is introduced.

## Dependency graph

```text
focused contract + migration policy
  -> manifest types/parser/static validation/pinning
    -> assignment and control schemas
      -> pure assignment resolver -> existing one-task admission service
        -> shared SDK tool bundle
        -> isolated RPC bridge tool bundle
          -> persistence/resume/concurrency regressions
            -> provider-adapter conformance + docs/deprecation
```

## Task list

### Phase 0 — approve the public contract

#### Task 1: Write and acknowledge the focused issue #121 specification

**Description:** Turn the proposed decisions above into a contract spec covering manifest syntax, tool schemas/results, authority resolution, persistence identity, migration, and non-goals. Resolve the open questions at the end of this plan before implementation.

**Acceptance criteria:**
- [x] The spec contains closed YAML and TypeScript examples for both `assignments_v1` and `legacy_v1`.
- [x] The spec states exact submission/control result shapes and idempotent-redelivery behavior.
- [x] The spec identifies controller-native general admission as an internal privileged caller, not the default model-facing API.
- [x] The overseer acknowledges the new spec before Task 2 starts.

**Verification:**
- [x] Cross-check every issue #121 acceptance criterion against a named spec section.
- [x] Confirm the spec does not change reducer, projection, sandbox, cost, cleanup, or manifest-pinning invariants.

**Dependencies:** None.

**Files likely touched:**
- `docs/issue-121-delegation-templates/spec.md`

**Estimated scope:** Small.

### Phase 1 — manifest-owned assignment policy

#### Task 2: Add and parse the versioned assignment contract

**Description:** Add typed assignment templates and delegation-interface selection. Parse and deeply freeze assignments without resolving filesystem-dependent projection policy. Normalize newly parsed omitted interfaces to the approved compatibility behavior while allowing old programmatic/pinned values to remain readable.

**Acceptance criteria:**
- [x] `DelegationPolicy` represents `assignments_v1` and `legacy_v1` without `any` or an ambiguous mixed shape.
- [x] Assignment objects reject unknown keys and malformed scalar/array values during parsing.
- [x] Existing manifests without assignment fields parse with unchanged legacy behavior.

**Verification:**
- [x] Add table-driven parser tests for valid assignment manifests, unknown fields, bounds, duplicates in closed arrays, and legacy omission.
- [x] Run the manifest assignment and delegation-mode suites.
- [x] Run `pnpm typecheck`.

**Dependencies:** Task 1.

**Files likely touched:**
- `src/manifest/types.ts`
- `src/manifest/parse.ts`
- `src/manifest/delegation-assignment.ts` (new)
- `tests/manifest/delegation-assignments.test.ts` (new)

**Estimated scope:** Medium.

#### Task 3: Statically validate assignment authority and pinned replay

**Description:** Validate assignment names and references against the parent policy, declared subagent profiles, profile projection/tool policy, and verification recipes. Prove the normalized assignments survive manifest snapshot creation and pinned-manifest resume unchanged.

**Acceptance criteria:**
- [x] Assignment names are valid and unique per parent role.
- [x] Every assignment profile is declared and present in `allowed_subagents`.
- [x] Tool and recipe selections can only narrow profile authority; unsafe/duplicate projection paths and workspace-mode conflicts fail closed.
- [x] `assignments_v1` requires assignments plus the approved role tool declarations; mixed legacy/assignment exposure is rejected.
- [x] Snapshot/resume uses the pinned assignments even if current YAML changes.

**Verification:**
- [x] Add table-driven static-validation tests for the assignment rejection cases and valid omission/default case.
- [x] Add a snapshot/resume regression proving the assignment template is digest-bound and loaded from `manifest_snapshot.normalized_manifest`.
- [x] Run focused manifest, snapshot, and grep-guard tests.

**Dependencies:** Task 2.

**Files likely touched:**
- `src/manifest/validate.ts`
- `src/host/api-pinned-manifest.ts`
- `tests/manifest/delegation-assignments.test.ts`
- `tests/host/delegation-assignment-resume.test.ts` (new)

**Estimated scope:** Medium.

### Checkpoint A — policy foundation

- [x] The focused spec is acknowledged.
- [x] Existing manifests remain legacy-compatible.
- [x] Assignment authority is statically rejected before host spawn when invalid.
- [x] Pinned resume is deterministic.
- [x] Focused tests and `pnpm typecheck` pass.

### Phase 2 — narrow seam and deterministic resolution

#### Task 4: Define separate closed TypeBox schemas

**Description:** Add the model-facing `delegate_task` and `delegation_control` schemas. Preserve the existing `delegate` schemas under explicit legacy/internal names and exports rather than widening the new schemas for compatibility.

**Acceptance criteria:**
- [x] Submission is exactly `{ assignment, brief }` with `additionalProperties: false` and no top-level union or array.
- [x] Control is exactly `{ operation, child_ids }`, closed and independent of submission.
- [x] Submission rejects `id`, `mode`, `subagent`, `expected_output`, `projection_paths`, `context_artifacts`, `tools`, `verification_recipe`, and `tasks`.
- [x] Legacy schema exports remain available with deprecation documentation.

**Verification:**
- [x] Add schema tests for valid boundaries, malformed values, unknown authority fields, and the historical nested-array failure.
- [x] Assert serialized submission schema has no `anyOf`/`oneOf` at its root and no nested task array.
- [x] Run the assignment seam and delegation suites.

**Dependencies:** Task 3.

**Files likely touched:**
- `src/seam/schema.ts`
- `src/index.ts`
- `tests/seam/delegation-assignments.test.ts` (new)

**Estimated scope:** Small.

#### Task 5: Resolve one assignment into one internal task

**Description:** Implement a pure host-agnostic resolver from `(pinned role policy, assignment args)` to one canonical internal task. It copies all authority fields from the assignment/profile policy and only maps `brief` to objective.

**Acceptance criteria:**
- [x] Resolution is deterministic for the same pinned manifest and arguments.
- [x] Unknown assignments and malformed direct-call values return typed failures before Git capture or child creation.
- [x] The canonical task ID, profile, output contract, projection selection, tools, recipe, and mode never originate from model arguments.
- [x] The resolver emits exactly one task and cannot accept a batch.

**Verification:**
- [x] Add resolver tests for unknown assignment, authority injection, deterministic output, and repeated assignment calls.
- [x] Assert forbidden authority fields are rejected by the closed schema and cannot alter resolved authority.
- [x] Run focused resolver and schema tests.

**Dependencies:** Task 4.

**Files likely touched:**
- `src/host/delegation/assignment-resolver.ts` (new)
- `src/host/delegation/delegate-error.ts`
- `tests/host/delegation-assignment-resolver.test.ts` (new)

**Estimated scope:** Small.

#### Task 6: Prove one-child durable admission and redelivery compatibility

**Description:** Feed the resolved task through the existing preparation and scheduler seams. Preserve the real SDK tool-call ID for idempotent redelivery, and verify one assignment call creates one atomic acceptance containing one child.

**Acceptance criteria:**
- [x] Successful submission persists one `delegation_submission_accepted` record with exactly one child before queueing/return.
- [x] Identical redelivery under the same tool-call identity returns the original child ID; changed assignment or brief rejects.
- [x] No worktree, start record, or child session exists after schema/resolution/admission rejection.
- [x] Existing acceptance records replay without migration; no record-version addition was required.

**Verification:**
- [x] Exercise acceptance ordering, fingerprints, identical/changed redelivery, restart replay, and unmatched-child recovery through the assignment and existing persistence/scheduler suites.
- [x] Run focused scheduler, reconciliation, and record-materialization tests.

**Dependencies:** Task 5.

**Files likely touched:**
- `src/host/delegation/scheduler.ts`
- `src/host/delegation/scheduler-fingerprint.ts`
- `src/host/delegation/scheduler-identity.ts`
- `tests/host/delegation-assignment-persistence.test.ts` (new)

**Estimated scope:** Medium.

### Checkpoint B — contract and admission

- [x] The new submission schema has no union, batch array, or caller authority fields.
- [x] One valid call resolves and durably admits exactly one child.
- [x] Malformed and escalating calls create no side effects.
- [x] Deterministic redelivery and legacy record replay are proven.
- [x] Focused tests and `pnpm typecheck` pass.

### Phase 3 — SDK and isolated-RPC tool surfaces

#### Task 7: Split the shared-SDK model surface into a tool bundle

**Description:** Refactor the cohesive factory/coordinator boundary to create either the legacy single `delegate` tool or the assignment-mode pair while sharing one scheduler/manager scope. Keep submission and control execution handlers separate and keep host terminal/admission guards unchanged.

**Acceptance criteria:**
- [x] `assignments_v1` exposes only `delegate_task` and `delegation_control`; `legacy_v1` exposes only `delegate`.
- [x] Both new tools share the same scheduler and parent lifecycle authority.
- [x] Submission results always contain one child ID; blocking mode may additionally include the terminal result.
- [x] Controls consume no admission slots and preserve existing status/result/wait/cancel semantics.
- [x] Nonblocking calls from distinct tool-call IDs can be accepted and run concurrently up to existing limits.

**Verification:**
- [x] Add direct SDK factory tests for tool names, schemas, result shapes, controls, and shared admission behavior.
- [x] Run existing delegation mode, async factory, parent retry, and child settlement regressions.

**Dependencies:** Task 6.

**Files likely touched:**
- `src/host/delegation/delegate-tool-factory.ts`
- `src/host/delegation/production-delegation.ts`
- `src/host/shared-sdk-role-spawn.ts`
- `src/host/production-host-delegation.ts`
- `tests/host/delegation-assignment-tools.test.ts` (new)

**Estimated scope:** Medium.

#### Task 8: Carry both tools through the isolated RPC bridge

**Description:** Version/generalize the static machine-tools configuration and request/reply framing so isolated roles register and forward separate assignment submission/control tools without conflating their schemas. Preserve actual SDK tool-call identity for submission; control calls do not create admission identity.

**Acceptance criteria:**
- [x] Host-written config explicitly selects legacy or assignment delegation tools from the pinned policy.
- [x] Each bridge frame is checked against its own closed schema and tool name.
- [x] Submission preserves the actual Pi tool-call ID across transport UUID redelivery.
- [x] Invalid/cross-tool frames are rejected before host execution and cleaned up safely.
- [x] Legacy pinned RPC sessions continue to register and bridge `delegate`.

**Verification:**
- [x] Extend RPC extension/config/bridge tests for registration, forwarding, malformed frames, timeout selection, redelivery, and legacy resume.
- [x] Run the RPC bridge, machine-tools extension, and isolated production spawn suites.

**Dependencies:** Task 7.

**Files likely touched:**
- `src/host/rpc/machine-tools-config.ts`
- `src/host/rpc/machine-tools-extension.ts`
- `src/host/rpc/delegate-bridge.ts`
- `src/host/rpc/node-role-bridges.ts`
- `tests/host/rpc/delegation-assignment-bridge.test.ts` (new)

**Estimated scope:** Medium.

#### Task 9: Restore StubHost/ProductionHost parity and recovery coverage

**Description:** Wire the tool bundle through shared, isolated, and stub session creation. Verify lifecycle settlement, abort, fallback, resume, and run-memory guidance use the correct interface without changing child execution.

**Acceptance criteria:**
- [x] StubHost and ProductionHost wire the same pinned tool names and schemas.
- [x] Parent handoff/end still waits for or cancels accepted children under existing rules.
- [x] Abort, budget exhaustion, fallback, and resume retain one terminal/recovery outcome per child.
- [x] Run-memory text names the active delegation interface without claiming admission availability.

**Verification:**
- [x] Exercise two assignment submissions plus independent status/wait controls through the shared assignment factory and the existing StubHost/production delegation suites.
- [x] Add direct and isolated resume regressions from pinned assignment manifests.
- [x] Run existing delegation loop, production host, resume, and issue #112 tests.

**Dependencies:** Task 8.

**Files likely touched:**
- `src/host/stub-host.ts`
- `src/host/production-host-spawn.ts`
- `src/host/isolated-role-spawn.ts`
- `src/host/run-memory.ts`
- `tests/host/delegation-assignment-e2e.test.ts` (new)

**Estimated scope:** Medium.

### Checkpoint C — host parity

- [x] Shared SDK, isolated RPC, and StubHost expose the same pinned interface.
- [x] Separate control and submission schemas survive both transport paths.
- [x] Concurrent accepted submissions obey existing admission and scheduling limits.
- [x] Abort/fallback/resume behavior remains fail-closed.
- [x] Focused suites, `pnpm typecheck`, and `pnpm build` pass.

### Phase 4 — migration, provider conformance, and operator documentation

#### Task 10: Preserve and deprecate the general delegate API

**Description:** Keep legacy public TypeScript exports and `legacy_v1` runtime behavior, mark them deprecated, and document an explicit migration from task arrays to assignments. Do not use Pi's `prepareArguments` to translate old model calls into the new surface: that would preserve forbidden caller authority. It may be used only if the approved spec identifies a resumed-session case where conversion is lossless and host-authoritative.

**Acceptance criteria:**
- [x] Existing library consumers compile against deprecated legacy exports.
- [x] Existing omitted-interface manifests and pinned snapshots retain current behavior.
- [x] New assignment manifests cannot expose or execute legacy model submission fields.
- [x] Migration includes manifest-version bump guidance and a rollback path to `legacy_v1` during the deprecation window.

**Verification:**
- [x] Exercise compile/runtime compatibility through the existing legacy import, manifest, schema, and pinned-snapshot suites.
- [x] Assert assignment-mode tool registries contain no `delegate` entry.

**Dependencies:** Task 9.

**Files likely touched:**
- `src/index.ts`
- `src/seam/schema.ts`
- `tests/package-metadata.test.ts`
- `tests/host/delegation-assignment-compatibility.test.ts` (new)

**Estimated scope:** Small.

#### Task 11: Add Pi provider-adapter conformance tests

**Description:** Against the pinned `@earendil-works/pi-ai` / coding-agent version, exercise the API-family adapters used by supported providers: Anthropic Messages, OpenAI-compatible chat/completions, OpenAI Responses, Google Generative/Vertex, Bedrock Converse, and Mistral Conversations. Use payload hooks or public conversion seams without network calls or API keys.

**Acceptance criteria:**
- [x] Every tested adapter receives a plain object submission schema with only `assignment` and `brief` properties.
- [x] No adapter payload contains a root submission union or nested `tasks` array.
- [x] The separate control schema preserves its closed operation/child-ID contract.
- [x] At least one Pi-level tool-call fixture per supported adapter family reaches TypeBox validation with valid args and rejects the historical malformed nested-array shape.
- [x] The test documents the exact pinned Pi version and adapter-family coverage so a dependency upgrade produces an actionable compatibility failure.

**Verification:**
- [x] Run the conformance suite without provider credentials or network access.
- [x] Cross-check adapter expectations against `pi-ai@0.80.6` source and each API family's tool conversion.

**Dependencies:** Tasks 8 and 10.

**Files likely touched:**
- `tests/host/delegation-provider-conformance.test.ts` (new)
- `tests/fixtures/delegation-provider-payloads.ts` (new, only if a shared fixture is needed)

**Estimated scope:** Medium.

#### Task 12: Update user and maintainer documentation

**Description:** Make assignment-based delegation the documented default, explain authority ownership, show controls and concurrency, and move the current batch examples into a clearly deprecated compatibility section.

**Acceptance criteria:**
- [x] User docs contain complete assignment manifest and tool-call examples.
- [x] Migration docs map every removed model field to its manifest owner.
- [x] Docs distinguish FSM handoff targets, assignment names, profiles, task IDs, and child IDs.
- [x] Changelog/release notes announce deprecation without promising an unapproved removal version.

**Verification:**
- [x] Run the repository lint/format checks and inspect documentation references.
- [x] Search published docs for unqualified `delegate.tasks[]` instructions; remaining occurrences are legacy, internal, or historical.

**Dependencies:** Tasks 10 and 11.

**Files likely touched:**
- `docs/delegation.md`
- `docs/role-config.md`
- `docs/role-tools.md`
- `README.md`
- `CHANGELOG.md`

**Estimated scope:** Medium.

### Checkpoint D — complete

- [x] Every issue #121 acceptance criterion maps to a passing test or documented compatibility guarantee.
- [x] `pnpm typecheck` passes.
- [x] `pnpm build` passes.
- [x] `pnpm test` passes, including grep guards and provider conformance.
- [x] `pnpm lint` passes.
- [x] `pnpm format:check` passes.
- [x] `git diff --check` passes.
- [x] `pnpm audit --prod` has no unaddressed high/critical advisory.
- [x] Final code review covers correctness, authority escalation, persistence/recovery, API compatibility, Pi adapter behavior, simplicity, and scope.
- [x] Plan and spec checkboxes accurately reflect only work actually completed.

## Acceptance-criterion traceability

| Issue #121 criterion | Planned evidence |
| --- | --- |
| No submission union or batch array | Task 4 schema/serialization tests; Task 11 adapter payload tests |
| No caller ID/mode/profile/tool/recipe/raw paths | Tasks 4–5 rejection and resolver tests |
| Templates statically validated and pinned | Tasks 2–3 manifest/snapshot tests |
| No authority widening | Tasks 3–5 static + runtime negative tests |
| One durable child admission and returned ID | Task 6 persistence/order tests; Task 7 result tests |
| Multiple submissions schedule concurrently | Tasks 7 and 9 scheduler/E2E tests |
| Separate closed controls | Tasks 4, 7, and 8 |
| Malformed, deterministic, recovery, migration coverage | Tasks 4–6, 9–10 |
| Provider-facing nested-array/adapters coverage | Task 11 |

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Compatibility shim accidentally preserves model authority | High | Separate tool names and schemas; legacy tool absent in assignment mode; no permissive union or deprecated fields in `delegate_task`. |
| Assignment policy is validated only at runtime | High | Static cross-reference checks in `src/manifest`; runtime revalidation remains defense in depth. |
| Current YAML changes affect resumed children | High | Resolve only from `loadedManifest.manifest`, which is reconstructed from the immutable snapshot on resume. |
| Tool pair receives different scheduler instances | High | Factory/coordinator returns one bundle bound to one logical-parent scope; tests submit through one tool and control through the other. |
| Blocking calls accidentally serialize all useful concurrency | Medium | Preserve policy semantics but prove the intended concurrent path with distinct nonblocking submissions under one scheduler. |
| Existing SDK/RPC callers break | High | Explicit `legacy_v1`, deprecated exports, pinned-snapshot tests, and isolated bridge compatibility fixtures. |
| Provider tests mirror Conductor schemas but miss Pi conversion | Medium | Exercise Pi API-family payload/conversion seams at pinned `0.80.6`; do not merely snapshot local TypeBox objects. |
| `delegate-tool-factory.ts` grows beyond its cohesion exception | Medium | Extract assignment resolution and small submission/control tool builders; keep lifecycle/scheduler ownership centralized. |
| Controller-native general tasks become an authority backdoor | Medium | Keep controller admission behind its existing host-owned executable/approval boundary; never register its task schema as the assignment-mode SDK tool. |

## Deliberately not changing

- FSM reducer, checkpoints, role transitions, or top-level role concurrency.
- Child execution, worktree creation, sandbox, projection enforcement, fixed verification execution, cost accounting, or cleanup semantics.
- Controller protocol or controller-native batch admission, except for type renames needed to distinguish internal and model-facing contracts.
- Automatic merge/cherry-pick/cleanup.
- Arbitrary dynamic context artifacts on `delegate_task`; trusted internal controller admission remains the route for host-issued artifacts unless a later spec adds a bounded assignment-owned source.
- Existing child-result protocol.

## Open questions requiring approval in Task 1

1. Should assignment mode preserve both blocking and nonblocking policy as proposed, or should `assignments_v1` require nonblocking so every submission returns immediately and all settlement happens through controls?
2. Is using the assignment name as the repeatable task ID acceptable, with `child_id` remaining the unique durable identity, or should the host derive a separate deterministic task ID from assignment plus SDK tool-call identity?
3. Should the role tool list explicitly contain `delegate_task` and `delegation_control`, or should one abstract `delegate` capability expand to both? This plan recommends explicit names because active-tool snapshots and RPC registration then describe the actual model surface.
4. What release/removal policy should apply to `legacy_v1`? This plan only deprecates it and does not choose a removal version.
5. Are the six Pi API families listed in Task 11 the intended meaning of “supported Pi tool-call adapters,” or must custom-provider adapters be included in the initial conformance matrix?
