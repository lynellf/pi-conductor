# Spec: Delegated tool projection and fixed verification recipes

**Status:** Acknowledged by the overseer on 2026-09-19 — implementation authorized

**Policy target:** Speed
**Authority:** This specification extends the delegated-child contracts documented in
`docs/delegation.md`, while preserving the archived FSM specification and Issues #55,
#57, #60, #86, #106, #111, and #112.

## 1. Objective

Let a delegator give a bounded child only the tools relevant to its task and optionally
bind that child to one pre-run verification recipe exposed as a parameterless
`verify()` tool. This is primarily for smaller local models that benefit from a narrow
action surface and a simple edit → verify → repair loop.

All executable verification logic is declared in the pinned manifest before the run
starts. A delegator may select an authorized recipe but cannot supply or modify its
executable, arguments, environment, or timeout. A child cannot select a different
recipe or provide command arguments.

This feature does not replace Bash-capable children. Profiles may continue to expose
sandboxed `bash`, and profiles without the new tool policy retain their existing tool
surface.

Success means:

1. A profile defines a maximum/default delegated tool authority, and each task may only
   narrow that authority.
2. A task may bind one manifest-declared verification recipe to parameterless
   `verify()`.
3. Verification runs child-modified code only inside the existing approved Bubblewrap
   workspace and never directly as the host user.
4. Recipe identity, effective tools, execution results, and call limits remain
   observable and stable across queueing, fallback, resume, and terminal settlement.
5. Existing manifests and delegated children retain current behavior when the new
   fields are absent.

## 2. User experience

A task-specific manifest can declare recipes:

```yaml
verification_recipes:
  - name: parser-focused
    commands:
      - executable: /usr/bin/pnpm
        args: [exec, vitest, run, tests/parser.test.ts]
    evaluation: report_only
    required_paths:
      - package.json
      - tests/parser.test.ts
    timeout_seconds: 180
    max_calls: 5
```

A profile can opt into explicit tool authority and authorize recipes:

```yaml
subagents:
  - name: local-implementer
    # models, budget, prompt, workspace, and execution omitted here
    tools:
      required: false
      allowed: [read, grep, find, ls, edit, write, verify, read_execution_output]
      default: [read, grep, edit, write, verify, read_execution_output]
    verification_recipes: [parser-focused]
```

The delegator binds a task to the recipe and may narrow its tools:

```json
{
  "id": "parser-green",
  "subagent": "local-implementer",
  "objective": "Make the accepted parser behavior test pass.",
  "expected_output": "A focused implementation and verification evidence.",
  "projection_paths": ["package.json", "src/parser.ts", "tests/parser.test.ts"],
  "tools": ["read", "grep", "edit", "write", "verify", "read_execution_output"],
  "verification_recipe": "parser-focused"
}
```

The child sees `verify()` with an empty object schema. It never sees a command argument
or recipe selector. It may use `read_execution_output` only when that tool is also in
its effective tool projection.

The syntax above is the required public contract unless implementation discovers a
conflict with an existing pinned schema. Any such conflict requires a spec update
before production behavior changes.

## 3. Manifest contract

### 3.1 Top-level `verification_recipes`

`verification_recipes` is an optional array of at most 64 entries. Omission preserves
current behavior. Recipe names use the existing task/profile identifier grammar and
are unique. One recipe's canonical JSON is at most 65,536 UTF-8 bytes and the complete
recipe inventory is at most 1,048,576 UTF-8 bytes, so pinning cannot create unbounded
manifest or persistence records.

Each recipe has this closed shape:

| Field | Contract |
| --- | --- |
| `name` | Required unique identifier. |
| `commands` | Required array of 1–16 fixed command entries. |
| `evaluation` | Required: `report_only`, `require_pass`, or `require_fail`. |
| `required_paths` | Required non-empty array of 1–64 unique safe exact repository-relative tracked files. It never widens a projection. |
| `timeout_seconds` | Required positive safe integer, 1–600, applied to each command and bounded by the profile's effective tool-execution deadline. |
| `max_calls` | Required positive safe integer, 1–32, shared by the child across model fallback/retry. |

Each command is closed and contains:

- `executable`: an absolute NUL-free path of at most 1,024 UTF-8 bytes rooted under
  `/bin`, `/sbin`, `/usr`, or `/opt` in the approved runtime;
- `args`: 0–128 literal NUL-free strings, each at most 4,096 UTF-8 bytes.

Recipes cannot declare shell source, environment, working directory, network,
credentials, host paths, glob expansion, interpolation, or output destinations.
Commands always execute directly as argv in `/workspace`, with the profile's pinned
sandbox environment and `network: none` policy. The implementation must not reconstruct
a shell command string from argv.

`require_fail` is valid only for a one-command recipe. This avoids ambiguous semantics
such as deciding which failure in a multi-command suite establishes expected RED.

### 3.2 Evaluation

- `report_only`: return execution facts; the delegator decides whether the evidence is
  acceptable.
- `require_pass`: the recipe expectation is satisfied only when every command exits
  zero.
- `require_fail`: the expectation is satisfied only when its single command exits
  nonzero.

All recipes run commands sequentially and stop after the first nonzero status,
timeout, cancellation, capture failure, or uncertain cleanup. `require_fail` never
asserts that the failure was behaviorally correct. The delegator must inspect its
bounded diagnostic and decide whether it is the expected RED failure rather than a
setup, baseline, skipped-test, or unrelated failure.

An unsatisfied expectation is a normal verification result, not a provider/model
failure and not automatic child termination.

### 3.3 Profile tool authority

A subagent profile may define an optional closed `tools` policy:

```yaml
tools:
  required: true | false
  allowed: [<tool names>]
  default: [<tool names>] # required only when required: false
```

Rules mirror declarative file projection:

- `allowed` is non-empty, duplicate-free, and contains at most 16 supported child tool
  names.
- `required: true` forbids `default`; every task using the profile must supply a
  non-empty `tools` selection.
- `required: false` requires a non-empty `default` subset of `allowed`.
- A task selection may only narrow `default` when defaults exist; it cannot select a
  merely allowed sibling.
- Every effective tool set is sorted, duplicate-free, non-empty, and a subset of the
  profile ceiling.
- A task supplying `tools` for a profile without a tool policy is rejected.
- A profile without a tool policy preserves the existing file-only or Bubblewrap child
  tool surface exactly.

Supported selectable names in this version are:

- file tools: `read`, `grep`, `find`, `ls`, `edit`, `write`;
- sandbox execution tools: `bash`, `read_execution_output`, `verify`.

`report_result` is selected by `completion_protocol`, remains host-injected, and is not
part of task-selectable authority. No child receives `delegate`, `request_files`,
`handoff`, `end`, or `ask_user` through this feature.

`bash`, `read_execution_output`, and `verify` require a profile with
`execution.backend: bubblewrap`. A file-only profile authorizing any of them is a
manifest error. Exposing `bash` does not require `verify`, and exposing `verify` does
not expose `bash`.

### 3.4 Profile recipe authority

`verification_recipes` on a profile is optional, duplicate-free, and references only
declared top-level recipes.

- A profile authorizing `verify` must use Bubblewrap and declare at least one authorized
  recipe.
- A profile that does not authorize `verify` must not declare profile recipe authority.
- A task binding `verification_recipe` must use a profile that authorizes that recipe
  and must include `verify` in its effective tool set.
- A task with effective `verify` must bind exactly one recipe.
- A task without effective `verify` must not bind a recipe.

The binding is one recipe per child in this version. A recipe may contain multiple
commands, so the model never needs `verify(recipe_name)`.

## 4. Admission, projection, and pinning

Before creating a worktree, private project, SDK session, or command process, the host
must resolve and validate the complete child authority:

```text
effective files E
  ⊆ parent materialized authority
  ∩ profile workspace authority

effective tools T
  ⊆ profile tool authority/defaults

bound recipe R
  ∈ profile recipe authority
  and R.required_paths ⊆ E
```

A recipe never silently adds files. Missing required files produce a typed batch
rejection naming the task, recipe, and missing path. Snapshot profiles use their
host-expanded exact admitted selection for the same containment check.

Acceptance pins:

- effective tool names;
- bound recipe name and SHA-256 digest over canonical JSON with sorted object keys and
  preserved array order;
- the same bounded canonical recipe contents used to compute that digest;
- effective file projection;
- sandbox/runtime identity and execution policy;
- task/profile/prompt fingerprints.

Task and request fingerprints include effective tools and recipe identity. Redelivery
of the same tool call is idempotent only when those values match exactly. Queued work,
resume, and model fallback use the pinned acceptance, never current YAML.

`delegation_submission_accepted` and `subagent_started` gain additive fields for the
effective tools and recipe identity/digest. Historical records without them retain
legacy semantics. Strict new-record schemas reject partial or inconsistent metadata.

Changing recipes or tool policies requires a manifest version bump for new runs and
never changes an in-flight run.

## 5. Child tool surface

### 5.1 Construction

The host builds the actual child SDK tool list from pinned effective authority, not
from prompt text and not from the current manifest. File tools retain existing path
confinement. Bubblewrap tools retain the existing operation gate, private
materialization, retained-output, cancellation, ingestion, and cleanup contracts.

A configured tool projection is exact: omitted tools are absent from both
`customTools` and the SDK-visible tool-name list. Prompt text lists only effective
tools and must not advertise unavailable capabilities.

### 5.2 `verify()` schema and behavior

The sole input schema is:

```ts
Type.Object({}, { additionalProperties: false })
```

Each accepted call:

1. checks the host-owned per-child recipe-call allowance;
2. executes the pinned fixed argv sequence through the existing Bubblewrap command
   lifecycle in the same private `/workspace` used by file tools;
3. applies the pinned timeout and existing output/capture limits;
4. stops on the first nonzero or non-clean terminal;
5. returns bounded structured evidence.

The result includes:

- recipe name and digest;
- call ordinal and remaining call allowance;
- evaluation policy and `expectation_satisfied` (`true`, `false`, or `null` for
  `report_only`);
- one entry per attempted command containing only ordinal, normalized numeric status,
  timeout/cancellation/cleanup classification, execution ID, opaque output reference,
  capture state, byte counts, and bounded stdout/stderr previews;
- the ordinal of the first unattempted command when execution stopped early.

The model does not receive hidden host paths, approval contents, command environment,
credentials, or another child's output. `read_execution_output` retains its existing
owner checks and bounded schema.

### 5.3 Call limits and recovery

`max_calls` applies to the logical child across model retries/fallbacks. Each admitted
call must have a durable execution start before process launch, so restart can
reconstruct consumed allowance without trusting model/session memory.

A rejected over-limit call starts no process and returns a stable diagnostic. An
unfinished or ambiguous verification execution uses the existing sandbox
reconciliation contract. It is never automatically replayed and never counted as a
successful expectation.

Verification completion does not approve a child patch, integrate it, advance a phase,
or replace parent verification.

## 6. Parent and review authority

Child verification is development feedback. The parent remains responsible for:

- inspecting the returned worktree bytes and diff;
- rejecting weakened, skipped, or out-of-scope tests;
- integrating accepted changes;
- running focused checks against the integrated phase;
- running applicable repository gates;
- recording expected RED and GREEN evidence;
- structured owner review and independent review routing;
- commits and conflict resolution.

A passing child recipe is not authoritative because a child can edit tests, operate on
an incomplete projection, or pass before sibling integration. A `require_fail` result
is likewise not RED proof until the delegator confirms the expected behavioral
failure.

## 7. Backward compatibility

When all new fields are absent:

- manifest parsing and validation preserve the current profile shape;
- delegate task schemas preserve current accepted calls;
- file-only children receive the current six confined file tools plus their completion
  protocol;
- Bubblewrap children receive the current file tools, `bash`, and
  `read_execution_output` plus their completion protocol;
- persisted historical records remain readable;
- no `verify` tool is registered;
- no sandbox approval is newly required.

This compatibility path needs explicit regression tests. It must not be implemented as
an implicit widening fallback after a malformed new policy; malformed configured
policy fails closed.

## 8. Technical boundaries

The pure reducer, checkpoint, lifecycle reducer, and machine definition do not change.
The feature is manifest/seam/persistence/host behavior:

```text
src/manifest/              recipe and tool-policy types, parse, static validation
src/seam/schema.ts         optional delegate task tools/recipe fields; empty verify schema
src/persistence/           accepted/start metadata and compatibility readers
src/host/delegation/       effective authority, pinning, prompt, child session wiring
src/host/execution/sandbox direct fixed-argv verification execution and output
```

No new dependency is expected. TypeBox remains the sole schema source.

Example style for public contracts:

```ts
/** Resolve task tools to an exact immutable child authority. */
export function resolveSubagentTools(
  policy: SubagentToolPolicy | undefined,
  requested: readonly ChildToolName[] | undefined,
): ToolResolution {
  // Pure validation and resolution; no I/O or ambient manifest reads.
}
```

Keep source modules below the repository's approximate 400-line ceiling. Do not add
more policy logic to the already oversized `src/manifest/parse.ts`; delegate parsing to
small feature modules.

## 9. Testing strategy

Use Vitest with table-driven contract tests and real host wiring tests.

### Manifest and seam

- accept valid required/default tool policies and recipes;
- reject unknown keys, duplicate/unsafe names, invalid subset relationships, invalid
  executable/args/limits, multi-command `require_fail`, missing recipe references, and
  incompatible execution backends;
- accept task narrowing and recipe binding in the TypeBox delegate schema;
- reject task widening, recipe/tool mismatches, and recipe use on legacy profiles.

### Admission and persistence

- resolve exact effective tools before child creation;
- reject missing recipe-required projection paths without creating a worktree/session;
- pin canonical recipe/tool metadata and include it in fingerprints;
- preserve idempotent redelivery only for identical authority;
- preserve pinned authority through queued execution, fallback, and resume;
- validate additive accepted/start records and legacy omission.

### Child tools

- prove actual SDK tool names equal the pinned effective set plus the completion tool;
- prove omitted Bash stays unavailable while `verify` works;
- prove Bash-capable configured and legacy profiles retain Bash;
- prove prompts list only effective tools.

### Verification execution

- prove `verify` accepts only `{}` and runs the pinned argv without shell
  reconstruction;
- prove child edits and verification share one private materialization;
- prove sequential fail-fast behavior and all evaluation policies;
- prove call caps survive model fallback/retry;
- prove output references remain child-owned and bounded;
- prove timeout, cancellation, capture failure, uncertain cleanup, restart, and
  reconciliation preserve existing fail-closed behavior;
- prove verification never runs directly in the host checkout.

### Backward compatibility and integration

- existing delegation, file-only, Bubblewrap, snapshot, source-workspace, async, and
  completion-protocol tests remain green;
- one integrated no-model test covers: accepted task → projected tools → edit →
  `verify()` fail → repair → `verify()` pass → retained output → validated child patch;
- real Bubblewrap verification is run only when separately approved host prerequisites
  are available and is reported distinctly from mocked/unit evidence.

## 10. Commands

Focused commands will be finalized in the implementation plan after acknowledgement.
The canonical repository gates are:

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm format:check
pnpm audit
```

Relevant focused suites include:

```bash
pnpm exec vitest run tests/manifest tests/seam/async-delegation.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/host/delegation-admission.test.ts tests/host/delegation-child-session-review.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/host/bubblewrap-command-tools.test.ts tests/host/sandbox-child-session-integration.test.ts --maxWorkers=1 --no-file-parallelism
pnpm exec vitest run tests/persistence/delegation-task.test.ts --maxWorkers=1 --no-file-parallelism
```

If the full suite approaches the conductor command supervisor deadline, partition it
into deterministic Vitest shards whose union equals `pnpm test`; do not omit files or
replay an unchanged timeout.

## 11. Boundaries

### Always

- Define executable verification logic before run start.
- Execute child-modified code only inside approved Bubblewrap confinement.
- Resolve and pin exact file, tool, recipe, runtime, and limit authority before spawn.
- Preserve parent acceptance, integrated verification, and independent review.
- Fail closed on malformed, missing, widened, stale, or inconsistent authority.
- Keep every task-specific recipe and tool selection observable.

### Ask first

- Supporting more than one bound recipe per child.
- Adding environment, working-directory, network, credential, interpolation, or shell
  fields to recipes.
- Adding arbitrary extension/custom tools to the projected tool registry.
- Changing existing Bubblewrap approval, runtime inventory, output, or reconciliation
  trust boundaries.
- Allowing verification outside Bubblewrap or directly in the host checkout.
- Changing projection/file-count limits or automatically widening file authority.

### Never

- Accept executable strings or argv from the delegator's runtime tool call.
- Expose a recipe selector or command arguments to `verify()`.
- Reconstruct a shell command string from recipe argv.
- Treat any nonzero result as sufficient RED proof.
- Treat child verification as patch approval or phase advancement.
- Silently remove Bash from legacy or explicitly Bash-capable profiles.
- Import Pi into pure core/manifest/seam/persistence layers.
- Auto-merge, auto-commit, auto-clean, or discard child worktrees.

## 12. Delivery phases

Implementation follows these ordered review-gated TDD phases after acknowledgement:

1. **Manifest and seam contract** — RED table tests, then recipe/tool-policy parsing,
   validation, task fields, and backward-compatible public types.
2. **Admission, durability, and exact tool surface** — RED host/persistence tests, then
   effective tool resolution, recipe/path binding, fingerprints, accepted/start
   records, prompt generation, and exact SDK tools.
3. **Sandboxed `verify()` execution** — RED command-tool tests, then fixed-argv
   execution, evaluation, output, call caps, fallback/restart behavior, and private
   workspace integration.
4. **Integrated compatibility and documentation** — RED no-model integration case,
   legacy regression gates, public documentation, complete repository gates, and final
   independent review.

Each phase requires observed expected RED before production implementation, green
focused checks and applicable repository gates, structured owner review, and an
independent fresh-context reviewer. The public schema, persistence, and sandbox trust
boundary make every phase a deterministic independent-review case.

## 13. Not doing

- General user-defined custom child tools.
- A repository-global recipe catalog outside the task-specific manifest.
- Child-selected named verification suites.
- Automatic phase-state enforcement in the reducer.
- Read-only reviewer profiles as a separate product feature.
- Networked verification or dependency installation.
- Resource quotas beyond existing output/deadline controls.
- Changes to model configuration or the external orchestration skill in this repository
  change. The skill should be updated separately after the runtime contract is shipped
  and verified.

## 14. Acceptance criteria

- [ ] New recipe and profile/task tool contracts parse, validate, and fail closed as
      specified.
- [ ] Legacy profiles and tasks preserve their exact existing tool behavior.
- [ ] Effective tools and recipe identity are pinned before child creation and survive
      queueing, fallback, and resume.
- [ ] `verify()` is strictly parameterless and executes only pre-run fixed argv inside
      the admitted private Bubblewrap workspace.
- [ ] `report_only`, `require_pass`, and single-command `require_fail` produce factual,
      bounded, auditable results without automatic phase approval.
- [ ] Call limits and uncertain execution recovery are host-owned and fail closed.
- [ ] Parent integration and repository verification remain authoritative.
- [ ] Focused tests and all canonical repository gates pass, with audit results reported
      rather than silently ignored.
- [ ] Public docs describe configuration, security boundaries, migration, and examples.
- [ ] Final independent review reports no blocking correctness, authority, persistence,
      recovery, or compatibility finding.

## 15. Open questions

None currently block implementation. Implementation discoveries that alter public
syntax, authority, execution, persistence, or recovery semantics require a spec update
and renewed overseer acknowledgement before proceeding.

## 16. Acknowledgement record

On 2026-09-19, the overseer approved this specification and authorized implementation.
The approved direction includes task-specific pre-run recipes, delegator judgment by
default through `report_only`, optional configured pass/fail expectations, preserved
Bash-capable child profiles, profile ceilings with optional task-level tool narrowing,
and deferred read-only reviewer profiles.
