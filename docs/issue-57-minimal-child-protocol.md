# Issue #57 — Minimal delegated-child protocol

**Status:** Acknowledged by the overseer and implemented. Verification evidence is recorded in §13.

**Source:** GitHub issue [#57](https://github.com/lynellf/pi-conductor/issues/57).

**Related authority:** archived FSM specification §§2–4, §§11–12; delegation-lite
spec §§4–8; Issue #26 (file-only children); Issues #51 and #52 (projection and
parent-bounded concurrency); and Issue #55 (authoritative delegated projection
policy).

## 1. Objective

Make a delegated child useful when it can perform bounded file work but cannot
reliably follow a conductor-specific terminal-tool protocol. A profile that
explicitly selects the minimal protocol gives the child ordinary confined file
tools and a narrow task card. When that child terminates normally, the **host**
normalizes its result from the actual terminal cause, a text-only final response,
and a verified child worktree.

Success is deliberately mechanical:

- a minimal child that leaves a verified changed worktree and a normal final
  response returns `completed` without calling `report_result`;
- a verified clean child with a normal final response returns `no_changes`;
- an explicit final-response blocker, cancellation, model/session failure,
  invalid Git state, or required response absence cannot be reported as success;
- the parent receives one ordered, host-normalized result per admitted task; and
- existing profiles retain the report-result protocol unless their manifest
  explicitly opts into the minimal one.

This is a reliability experiment for bounded child work, **not** a claim that a
small model can complete arbitrary work or that a changed worktree is correct.

## 2. Assumptions and proposal status

The overseer acknowledged all four decisions in §16 before implementation. The
following contract is therefore authoritative for this implementation slice.

1. The smallest safe migration is a profile-level opt-in. Existing profiles
   remain on `report_result`; a parent cannot select the protocol ad hoc at a
   `delegate` call.
2. A final-response blocker must use a deterministic marker rather than host
   natural-language classification. This draft uses `BLOCKED:`.
3. The host must wait for terminal settlement and inspect Git before publishing
   a child terminal record. A tool-call observation alone is not final.
4. `blocked` is a distinct parent-facing outcome, carried by the existing
   non-success terminal record family, so it is not conflated with a provider
   failure or cancellation.

These are acknowledged implementation decisions; §16 records the implementation
authorization.

## 3. Scope and non-goals

### In scope

- an opt-in minimal completion protocol for `subagents` profiles;
- a host-owned, deterministic result-normalization function;
- final-response capture that excludes reasoning/thinking content;
- additive child records, result fields, roll-ups, and stats needed to compare
  legacy and minimal cohorts honestly;
- tests for every normalization condition and conflict; and
- retention of child worktrees and branches for parent/operator inspection.

### Explicitly out of scope

- child `bash`, `run`, Git, subprocess, process, or shell execution;
- child `handoff`, `end`, `ask_user`, `delegate`, `request_files`, child-to-child
  communication, or child self-expansion of a projection;
- automatic tests, commits, merges, cherry-picks, patch application, cleanup,
  reset, or integration by the host or child;
- a second projection system, automatic retrieval, or a general permission
  framework;
- retries, fallback chains, global child scheduling, or child recovery beyond
  the existing cancellation-on-resume behavior;
- concurrent top-level FSM roles or changes to the reducer, checkpoint,
  `MachineDefinition`, FSM topology, or role lifecycle; and
- claiming code correctness, quality, throughput, cache-hit rate, or causal
  model/protocol improvement from these records.

Bounded child concurrency remains only inside the currently active parent visit,
using its existing `max_parallel` pool. The top-level FSM remains single-active.

## 4. Authority and lifecycle boundaries

The existing authority hierarchy remains unchanged.

1. The parent validates a whole `delegate` batch before any child starts. The
   parent checkout must be clean and Git-valid; Issue #55 continues to resolve
   an exact effective child projection `E` before sparse-worktree setup.
2. The host creates and verifies the generated child worktree and uses the
   profile-selected completion protocol. A child is not an FSM role and cannot
   persist records or call `reduce`.
3. A child may use only its path-confined file tools inside its generated
   worktree. Under a projected profile it sees only `E`; it cannot use
   `request_files` or otherwise enlarge `E`.
4. The host mechanically inspects child terminal state. This mechanical
   inspection is not semantic verification of the change.
5. The parent receives ordered results, then alone inspects the retained
   worktree/branch, runs tests and other verification, decides whether work is
   adequate, commits, and integrates. The host never integrates automatically.

For an isolated parent, the delegate base remains the parent's workspace and its
captured materialized authority `H`; no minimal child can receive a projection
wider than that parent. Therefore Issue #55's invariant still holds:

```text
E ⊆ profile projection authority ∩ parent clean materialized H
```

A dirty child worktree is only evidence of file mutation. It is never evidence
that a blocker, cancellation, or model/session failure did not happen.

## 5. Manifest and migration contract

### 5.1 Opt-in profile field

Add this optional field to a `SubagentProfile`:

```yaml
subagents:
  - name: focused-implementer
    models: [{ model: local:coder, effort: medium }]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/focused-implementer.md
    completion_protocol: minimal # report_result is the default when omitted
    workspace:
      projection:
        required: false
        allowed_paths: [src/parser, tests/parser]
        default_paths: [src/parser, tests/parser]
```

The closed enum is:

```ts
type ChildCompletionProtocol = "report_result" | "minimal";
```

Rules:

- omitted `completion_protocol` normalizes to `"report_result"`;
- only a declared profile may choose `"minimal"`; it is not a
  `delegate.tasks[]` input and cannot be model-selected at runtime;
- a manifest version bump is required because profile semantics change;
- an unknown value is a manifest parse/validation error before a parent session
  can receive `delegate`; and
- the pinned manifest snapshot fixes the protocol for every child in that run.

### 5.2 Legacy compatibility

For an omitted field or explicit `report_result`:

- the child prompt, `report_result` tool, child tool set, and normal
  report/worktree mapping remain as they are today; the host only postpones
  publication of the terminal record until settlement so the §7.2
  cancellation/error precedence can be applied;
- a normal end without a valid `report_result` remains
  `failed`/`missing_report_result`, even if the worktree is dirty;
- existing report/worktree normalization remains: `completed` + clean becomes
  `no_changes`; `no_changes` + dirty becomes `failed`; and `failed` stays
  `failed`;
- old persisted records with no `completion_protocol` are read as legacy
  `report_result` records for aggregate views, without rewriting history; and
- new additive telemetry fields may appear on newly written legacy records, but
  no existing consumer is required to read them.

This avoids silently migrating profiles whose prompts and tests expect a
terminating tool. A profile author opting into `minimal` must also remove stale
`report_result` instructions from that profile's declared system prompt in the
same manifest version. The host does not scan or rewrite arbitrary profile
prompts; the task card's no-tool instruction is not a compatibility migration
for a contradictory base prompt. This also keeps an A/B comparison possible:
use the same profile and task data with an explicitly different pinned manifest
version.

## 6. Child tool and prompt surfaces

### 6.1 Tool sets

| Profile protocol | Enabled child tools |
| --- | --- |
| `report_result` | `read`, `grep`, `find`, `ls`, `edit`, `write`, `report_result` |
| `minimal` | `read`, `grep`, `find`, `ls`, `edit`, `write` |

Both remain confined to the generated child worktree. Neither receives `bash`,
`run`, Git tools, process execution, `delegate`, `request_files`, `handoff`,
`end`, or a parent custom tool. The actual SDK session tool list—not merely the
prompt—is the enforcement point.

### 6.2 Minimal task card

The minimal prompt appends only this task card to the declared profile prompt:

```text
TASK
Goal:
<objective>

Visible files:
<the resolved exact E list, or "the files materialized in this worktree">

Required behavior:
- Work only through the available file tools.
- Stay within the visible files and do not run commands.

Expected outcome:
<expected_output>

When finished, respond normally with a concise final summary. Do not call a
conductor completion tool. If you cannot continue because required context or
an external dependency is missing, start the first non-empty line of the final
response with: BLOCKED: <reason>
```

The host must not add the parent transcript, sibling identities, branch name,
worktree-management instructions, FSM topology, integration instructions, or
report-result instructions to this card. The task-card formatter may state an
exact `E` list only when one already exists; it must not disclose paths outside
that set. A non-projected legacy-full child is described as having the files
materialized in its worktree, rather than receiving an unbounded path list.

### 6.3 Final response definition

For minimal mode, a **final response** is the text-only content of the
**last assistant `message_end` before `agent_end`**. It qualifies only when the
child reaches `agent_end` with no cancellation or model/session terminal cause;
the collector must not skip an empty final assistant message to reuse text from
an earlier turn. The collector must use only `text` content blocks:

- it must not use the display-only `extractAssistantText` helper or any other
  display formatter that joins in thinking/reasoning blocks;
- it must not retain tool arguments, hidden reasoning, or chain-of-thought;
- whitespace-only text is absent; and
- the parent-facing/persisted summary is capped at the existing 4,096-character
  limit, with `summary_truncated: true` when truncation occurred.

An **explicit blocker** is a final response whose first non-empty line begins,
case-sensitively, with `BLOCKED:`. The blocker reason is the remainder of that
line plus subsequent text, trimmed. If the marker has no reason, retain the
stable synthetic reason `child reported BLOCKED without a reason`; it is still a
blocker and never a success.

No semantic classifier may decide that prose such as “I might be blocked” is a
blocker. It is an ordinary final response unless it uses the marker above.

## 7. Host-owned terminal normalization

### 7.1 Raw observations

The child runner collects, but does not trust as a result, these observations:

- selected completion protocol;
- whether a valid `report_result` call occurred and its status/summary;
- whether the run's `DelegationManager` cancelled the child;
- any model/session terminal cause, including provider error, prompt/session
  failure, RPC-child exit, and a child session-cost abort;
- the minimal protocol's text-only final response, if any; and
- post-terminal Git inspection of generated path, expected branch, `HEAD`,
  porcelain state, and changed paths.

A valid legacy `report_result` is captured when called but is not published as a
terminal outcome until the child session has settled and host terminal causes
are known. This closes the race where a model calls the tool then errors or is
cancelled before it actually terminates.

A worktree is **verified** only when all checks pass:

1. generated worktree realpath equals Git's reported repository top level;
2. current branch equals the generated branch;
3. `HEAD` equals the captured batch `base_commit`; and
4. `git status --porcelain=v1 --untracked-files=all` succeeds.

A verified dirty worktree is `changed`; a verified clean worktree is `clean`.
A different `HEAD`, wrong path/branch, unavailable Git command, or failed status
inspection is `invalid`. A setup failure that leaves no inspectable worktree is
`uninspected`. A child may not create commits; a changed `HEAD` is invalid even
when the worktree is also dirty.

### 7.2 Total precedence

The following table is the authoritative total order. Evaluate it from priority
1 downward and choose the first matching row. Lower-priority observations are
still persisted in the audit fields, but cannot change the published status.

| Priority | Condition | Published status | `normalization_reason` | Required behavior / conflict rule |
| ---: | --- | --- | --- | --- |
| 1 | Host/run cancellation observed | `cancelled` | `cancelled` | Wins over every response, report, and worktree state. Preserve any final response/report data as diagnostics. |
| 2 | Model or session terminal error observed | `failed` | `model_or_session_error` | Wins over blocker, report, and worktree state. Includes provider error, session-cap abort, prompt/RPC error, and abnormal child termination. |
| 3 | Git state is `invalid` | `failed` | `invalid_git_state` | A report or normal response cannot make an invalid worktree successful. Preserve a blocker/report observation as diagnostics. |
| 4 | Minimal-mode final response has the explicit `BLOCKED:` marker | `blocked` | `final_response_blocked` | Wins over changed or clean state. Partial edits remain retained for parent inspection, never implied successful. |
| 5 | Legacy `report_result` is present | See §7.3 | See §7.3 | Applies only to `report_result` profiles. It outranks the legacy missing-report fallback and prevents a dirty worktree from inventing a successful legacy result. |
| 6 | Required completion text is absent | `failed` | `missing_final_response` or `missing_report_result` | In minimal mode, a changed or clean worktree cannot substitute for a final response. In legacy mode, preserve the existing missing-report failure. |
| 7 | Minimal-mode normal terminal response + verified worktree | `completed` when `changed`; `no_changes` when `clean` | `normal_final_response_changed` or `normal_final_response_clean` | This is the only host-owned successful path without `report_result`. |

Consequences of the order:

- Cancellation wins if cancellation and any other signal race.
- A provider/session error wins over a final `BLOCKED:` response. This preserves
  the mechanical fact that the attempt errored; the response remains auditable.
- Invalid Git wins over a blocker because the host cannot certify the child
  workspace it is returning. The blocker reason remains visible.
- A dirty worktree never masks cancellation, model/session failure, invalid Git,
  a blocker, a missing final response, or a legacy report conflict.
- `uninspected` is not a normal worktree state. If no higher host error already
  explains it, normalize it as `failed`/`invalid_git_state`.

### 7.3 Legacy report-result mapping

At precedence row 5, normalize a valid legacy report against the verified
worktree as follows:

| `report_result.status` | Worktree state | Status | `normalization_reason` |
| --- | --- | --- | --- |
| `failed` | `changed` or `clean` | `failed` | `report_result_failed` |
| `completed` | `changed` | `completed` | `report_result_completed_changed` |
| `completed` | `clean` | `no_changes` | `report_result_completed_clean` |
| `no_changes` | `clean` | `no_changes` | `report_result_no_changes_clean` |
| `no_changes` | `changed` | `failed` | `report_result_conflicts_with_worktree` |

Rows 1–3 apply before this table. Thus a valid report cannot hide cancellation,
a session failure, or invalid Git. A legacy session that ends without a valid
report reaches row 6 and retains the existing `missing_report_result` failure,
not row 7.

### 7.4 Normalization pseudocode

```ts
function normalizeChild(raw: RawChildTerminal): NormalizedChildTerminal {
  if (raw.cancelled) return cancelled(raw);
  if (raw.sessionError !== null) return failed(raw, "model_or_session_error");
  if (raw.worktree.state !== "changed" && raw.worktree.state !== "clean") {
    return failed(raw, "invalid_git_state");
  }
  if (raw.protocol === "minimal" && isExplicitBlocker(raw.finalResponse)) {
    return blocked(raw, "final_response_blocked");
  }
  if (raw.protocol === "report_result" && raw.report !== null) {
    return normalizeLegacyReport(raw);
  }
  if (raw.protocol === "report_result") return failed(raw, "missing_report_result");
  if (raw.finalResponse === null) return failed(raw, "missing_final_response");
  return raw.worktree.state === "changed"
    ? completed(raw, "normal_final_response_changed")
    : noChanges(raw, "normal_final_response_clean");
}
```

`RawChildTerminal` must preserve the observations necessary to explain the
chosen outcome. The normalizer is a host/delegation pure helper: it does not call
the FSM reducer, persist records, spawn, or mutate a worktree.

## 8. Parent result and persisted records

### 8.1 Parent-facing `delegate` result

Extend the existing ordered `DelegateTaskResult` shape. Fields currently present
(`task_id`, `subagent`, `child_id`, `summary`, `verification`, branch/worktree
identity, base/head commits, session file, usage, and `failure_reason`) remain.
Newly produced results add:

```ts
type DelegateResultStatus =
  | "completed"
  | "no_changes"
  | "blocked"
  | "failed"
  | "cancelled";

interface ChildCompletionEvidence {
  readonly completion_protocol: "report_result" | "minimal";
  readonly completion_source: "report_result" | "final_response" | "host";
  readonly normalization_reason: ChildNormalizationReason;
  readonly report_result_called: boolean;
  readonly reported_status?: "completed" | "no_changes" | "failed";
  readonly final_response_present: boolean;
  readonly summary_truncated: boolean;
  readonly blocker_reason?: string;
  readonly worktree_state: "changed" | "clean" | "invalid" | "uninspected";
  readonly changed_path_count?: number;
  readonly changed_paths?: readonly string[];
  readonly changed_paths_truncated?: boolean;
  readonly file_tool_calls: {
    readonly read: number;
    readonly grep: number;
    readonly find: number;
    readonly ls: number;
    readonly edit: number;
    readonly write: number;
  };
  readonly duplicate_read_calls: number;
}
```

`summary` selection is deterministic and protocol-specific:

- for `minimal`, when a text-only final response is present, use its capped
  text for every outcome, including a later host failure/cancellation (the
  authoritative status and `failure_reason` still describe that host cause);
- for `report_result`, when a valid legacy report is present, use its capped
  report summary; and
- otherwise use the stable failure description already used for
  `failure_reason`, not an invented model summary.

`final_response_present` is true only for the minimal-mode completion artifact.
It is false on newly written legacy records regardless of incidental assistant
text observed before `report_result`; legacy records do not retain a second
transcript-derived summary. This preserves the legacy summary contract while
still retaining the minimal response needed for normalization. In every case,
the normalized status—not the summary text—is authoritative.

`blocked` retains `failure_reason: "final_response_blocked"` for compatibility
with consumers that already inspect `failure_reason`; `blocker_reason` carries
the bounded extracted reason. It is a distinct `status`, not a successful
completion or a model/provider failure.

### 8.2 Durable record changes

Every newly started child appends one `subagent_started` record with these
additive fields:

```ts
{
  completion_protocol: "report_result" | "minimal",
  task_fingerprint: string,        // SHA-256; §9.1
  projection_fingerprint: {
    kind: "exact" | "full_materialized",
    path_count: number,
    sha256: string,
  },
}
```

Every started child still appends exactly one terminal record. Keep the existing
record family to preserve lifecycle/query compatibility:

- `subagent_completed.status` remains `"completed" | "no_changes"`;
- extend `subagent_failed.status` to
  `"failed" | "cancelled" | "blocked"`; and
- attach `ChildCompletionEvidence` fields to both terminal record shapes.

For newly written terminal records, all evidence fields other than the
conditional `reported_status`, `blocker_reason`, and changed-path fields are
required. `reported_status` is present whenever a valid report was captured,
and `blocker_reason` is present whenever a minimal final response used the
marker—even when a higher-priority cancellation, session error, or invalid Git
state chose another published status. `completion_source` is `host` for rows
1–3 and 6, `final_response` for rows 4 and 7, and `report_result` for row 5.
The fields are optional when reading historical JSONL records. A `blocked` record
is deliberately in the non-success terminal family: it has no automatic recovery
or integration semantics, while its `status` preserves the distinction for the
parent and stats.

Resume continues to terminalize an unmatched `subagent_started` as
`subagent_failed { status: "cancelled", failure_reason:
"recovered_child_lost" }`. If the start record has a protocol, copy it and set
`completion_source: "host"`, `normalization_reason: "cancelled"`,
`final_response_present: false`, and `worktree_state: "uninspected"`.
Historical starts lacking the field remain readable as legacy and do not require
a log rewrite.

### 8.3 Git evidence and bounds

On a verified terminal, derive changed paths from Git's tracked diff against
`HEAD` plus untracked, non-ignored paths. Report at most 64 lexically sorted
repository-relative paths, with:

- `changed_path_count`: the total observed count;
- `changed_paths`: the retained prefix; and
- `changed_paths_truncated: true` when the count exceeds 64.

Ignored files are neither counted nor treated as work, matching the existing
porcelain clean-gate semantics. Do not record diff contents, line counts, file
bytes, arbitrary tool paths, or Git command output. Invalid/uninspected states
omit changed-path fields.

This evidence is for inspection and cohort matching, not a claim that the
listed files are correct, complete, tested, or integrated.

## 9. Telemetry and comparison limits

### 9.1 Cohort identity and available measurements

New records make the following comparison dimensions available per child:

| Dimension | Source |
| --- | --- |
| Protocol shape | `completion_protocol` and `completion_source` |
| Candidate model/profile | existing `subagent`, `model`, and new protocol field |
| Same bounded task | `task_fingerprint`, `base_commit`, and projection fingerprint |
| Projection context | existing exact `projection_paths` when present; new kind/count/hash for all starts |
| Terminal outcome | `status`, `normalization_reason`, report/final-response presence, blocker and failure reason |
| File outcome | verified `worktree_state` and bounded changed-path evidence |
| Tool activity | terminal file-tool call counters and strict duplicate-read count |
| Cost/token usage | existing terminal `usage`, current per-run/per-model/per-subagent rollups |
| Host elapsed span | existing `subagent_started.ts` and terminal `ts` for a matched child id |

`task_fingerprint` is SHA-256 of a canonical UTF-8 encoding of the objective,
expected output, captured base commit, and sorted effective materialized path
set. It excludes protocol, model, and the reporting prompt text so equivalent
work can be grouped across candidate protocols/models without persisting the raw
task card a second time.

`duplicate_read_calls` counts only the second and later `read` tool starts with
an identical canonical `{ path, offset, limit }` argument tuple in one child
attempt. It counts attempts, including failed reads. It does **not** claim that
the model forgot context, re-read semantically identical content under a
different range, or consumed any particular number of bytes/tokens.

### 9.2 Aggregate projections

Keep existing `perRun`, `perModel`, and `perSubagent` usage behavior. Add a
pure `perChildProtocol` usage dimension keyed by `report_result` and `minimal`.
Extend child lifecycle stats with a protocol-keyed projection containing started,
completed, no-change, blocked, failed, cancelled, report-called,
final-response-present, and missing-final-response counts. Each terminal record
contributes once; `blocked` and `cancelled` usage still contribute to total and
per-model/per-subagent cost exactly once when usage is available.

Do not change parent `perRole` accounting: child usage remains outside parent
role lifecycle usage, as it is today.

### 9.3 Metrics this feature must not claim

The records can support descriptive, task-matched comparisons. They cannot show
that a protocol caused better quality or throughput, because task selection,
model selection, projection, prompt, retries, host load, and parent behavior
are confounders. In particular, do not present:

- a per-run cache-hit rate (cache reuse is provider/session dependent);
- read bytes, semantic repeated-reading, hidden reasoning, or context-window
  utilization;
- model latency, queue time, provider execution time, or a precise throughput
  metric. The start/terminal timestamp difference is only a host-observed
  elapsed span;
- test success, reviewer acceptance, correct integration, or task quality from
  a dirty worktree or `completed` status; or
- an unlabeled comparison between profiles/tasks with different fingerprints or
  projections.

No new UI is required for v1. The append-only records and existing record emitter
are the source of truth; a later consumer may render the additive stats.

## 10. Implementation boundaries

### Always

- Keep the reducer, checkpoint, `MachineDefinition`, role FSM topology, and
  top-level role lifecycle unchanged.
- Keep `delegate` a parent-owned host tool that never creates a machine event.
- Validate batch, profile policy, clean parent, `H`, and exact `E` before child
  worktree/session creation.
- Use standalone child sessions, TypeBox for the retained `report_result`
  schema, and the actual confined SDK file-tool allowlist.
- Run the total normalizer only after terminal settlement plus attempted Git
  inspection; append one terminal record for every started child.
- Retain child worktrees/branches and make all parent inspection, verification,
  commits, and integration explicit.
- Preserve ordered pool results and `max_parallel` bounded only inside the
  active parent.

### Ask first

- Changing the `BLOCKED:` grammar, result precedence, `blocked` outcome, or
  4,096-character/64-path bounds.
- Adding any child tool, a child context-expansion mechanism, a shell/process
  surface, automatic integration, global scheduling, retries, or a UI command.
- Changing record compatibility, task/projection fingerprint content, telemetry
  privacy policy, dependencies, or the manifest default.

### Never

- Let a child run a shell/process/Git command, alter the primary checkout, or
  create a commit.
- Let a child expand or bypass its projection, target the FSM, invoke parent
  tools, persist directly, or self-delegate.
- Let a changed worktree override a blocker, cancellation, model/session error,
  invalid Git state, or missing required completion response.
- Auto-merge, apply, discard, reset, delete, test, verify semantically, commit,
  or integrate a child result.
- Add top-level FSM concurrency or claim a worktree is an OS/credential sandbox.

## 11. Testing strategy and acceptance matrix

Use table-driven tests with temporary real Git repositories and the existing stub
provider/real SDK child sessions. No live provider is needed. Every matrix row
asserts one behavior and inspects the actual child tool surface or durable
records where applicable.

| Area | Required cases |
| --- | --- |
| Manifest migration | omitted field is legacy; explicit `report_result` is legacy; `minimal` parses; invalid protocol fails before child creation; pinned manifest keeps selected protocol across the run. |
| Actual tool surface | legacy has exactly file tools plus `report_result`; minimal has exactly the six file tools; both exclude shell/process/FSM/delegation/request-files tools and reject absolute, traversal, and symlink escape paths. |
| Minimal task card | card contains objective, expected output, constraints, and only the resolved projection description; excludes report-result, branch, sibling, parent transcript, FSM, and integration language. |
| Minimal normal terminal | text final + verified dirty base worktree → `completed`; text final + verified clean base worktree → `no_changes`; returned/persisted summary is text-only and bounded. |
| Explicit blocker | `BLOCKED:` with dirty and clean worktrees → `blocked`; marker with missing reason receives the stable synthetic reason; ordinary prose without marker follows normal worktree mapping. |
| Missing completion | minimal missing/whitespace-only final with dirty and clean worktrees → `failed/missing_final_response`; legacy end without valid report with dirty and clean worktrees → unchanged `failed/missing_report_result`. |
| Legacy report mapping | every §7.3 row, including `completed` + clean normalization and `no_changes` + dirty conflict; explicit report `failed` remains failed. |
| Host-signal precedence | cancellation + dirty + blocker/report; model/session error + dirty + blocker/report; invalid Git + dirty + blocker/report; assert §7.2 primary status and retained raw evidence. |
| Git verification | wrong realpath, branch, changed `HEAD`, Git/status failure, and uninspectable setup all fail; verified changed path list is sorted/bounded; ignored files are not called changes. |
| Projection/authority regression | Issue #55 default/required/narrowed exact `E` remains authoritative; a minimal projected child cannot read outside `E` or request expansion; an isolated parent cannot delegate beyond `H`. |
| Pool/FSM regression | at least two minimal children obey `max_parallel`, preserve input order, and do not create a top-level FSM transition or parallel role; one child failure/blocker does not cancel siblings. |
| Persistence/stats | one start and exactly one terminal per started child; old records parse; new fields round-trip; `blocked` appears in stats; usage enters per-run/model/subagent/protocol exactly once and never parent `perRole`; resume produces one cancellation terminal. |
| Telemetry truthfulness | task/projection fingerprints differ when inputs differ; duplicate-read counter follows exact tuple semantics; text-only response excludes thinking; aggregate views expose no cache-hit rate, quality score, or fabricated timing metric. |

Acceptance requires the issue's listed scenarios: changed normal completion,
unchanged normal completion, explicit blocker, model failure, cancellation, and
legacy report-result completion—plus the conflict rows above that prevent dirty
work from hiding a failure.

## 12. Ordered implementation plan

The tasks are deliberately sequential around the shared result contract. No task
may start before the acknowledgement in §16.

### Task 1 — Manifest and public contract

- [x] Add `completion_protocol` parsing/validation/defaulting and public child
      protocol/outcome/evidence types.
  - **Acceptance:** absent profiles retain legacy protocol; invalid values fail at
    manifest load; manifest versioning is documented in code comments/tests.
  - **Likely files:** `src/manifest/{types,parse,validate}.ts`,
    `src/host/delegation/{delegate-tool,pool}.ts`, tests.
  - **Verify:** focused manifest/delegation tests and `pnpm typecheck`.

### Task 2 — Pure inspection and normalization seam

- [x] Extract a small host-only pure normalizer and extend worktree inspection
      to produce the verified state and bounded changed-path evidence.
  - **Acceptance:** every §7.2/§7.3 table row is unit-tested without an SDK
    session; changed `HEAD` is invalid before dirty/clean classification.
  - **Likely files:** new `src/host/delegation/child-result.ts`,
    `src/host/delegation/worktree.ts`, `tests/host/delegation.test.ts`.
  - **Verify:** focused delegation tests and `pnpm typecheck`.

### Checkpoint C1 — Normalization contract green

- [x] The pure precedence table, legacy compatibility rows, and Git evidence
      bounds are tested before changing child session wiring.

### Task 3 — Child prompt, tools, and terminal observation

- [x] Select the protocol per profile; remove `report_result` from only minimal
      child SDK sessions; capture text-only final responses/tool counters; wait
      for terminal settlement; then call the normalizer.
  - **Acceptance:** actual minimal SDK child sessions expose only six confined
    file tools; legacy actual sessions retain `report_result`; no normal child
    success depends on a tool call in minimal mode.
  - **Likely files:** `src/host/delegation/{child-prompt,delegate-tool-factory,
    delegate-tool,run-tool,pool}.ts`, stub fixtures, focused tests.
  - **Verify:** focused SDK child/delegation tests and `pnpm typecheck`.

### Task 4 — Persistence, roll-up, and stats

- [x] Persist the start/terminal evidence, support `blocked`, fingerprint task
      and projection inputs, and add the protocol aggregate projections.
  - **Acceptance:** old logs remain readable; one terminal is emitted per start;
    child usage is counted exactly once in all required dimensions; no parent
    lifecycle accounting changes.
  - **Likely files:** `src/persistence/log.ts`, `src/host/log-file.ts`,
    `src/cost/rollup.ts`, `src/host/stats.ts`, record/stats tests.
  - **Verify:** focused persistence/cost/stats tests and `pnpm typecheck`.

### Checkpoint C2 — End-to-end behavior green

- [x] Real-Git/stub-provider scenarios cover minimal changed/clean/blocker/error/
      cancellation/missing-final and all legacy report mappings.
- [x] Issue #51/#52/#55 and Issue #26 regression cases remain green: exact
      projection, file-only confinement, parent-only bounded concurrency, and
      explicit parent reconciliation.

### Task 5 — Full regression and documentation review

- [x] Run the repository gates, inspect durable JSONL/result compatibility, and
      perform an adversarial review of precedence/authority claims. `pnpm audit`
      remains a pre-existing dependency-security failure recorded below.
  - **Acceptance:** no reducer/checkpoint/top-level-FSM change; no child shell,
    expansion, or automatic integration; this spec is updated only if evidence
    forces a contract correction.
  - **Likely files:** implementation and tests above; no README change is part
    of this specification delivery.
  - **Verify:** commands below and review of the final diff.

## 13. Commands and verification gates

Implementation must run the focused test commands named in each task, then the
repository gate:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm audit
```

For the present documentation-only change, verify scope and Markdown whitespace
without modifying generated artifacts:

```bash
git diff --check
git status --short
```

`pnpm audit` results must be reported faithfully. Existing unrelated advisories
must not be presented as resolved by this feature.

**Implementation verification (2026-08-27):** focused Issue #57/legacy/projection/
roll-up tests passed (105 tests); `pnpm typecheck`, `pnpm build`, `pnpm test`
(99 files, 1,319 tests), `pnpm lint`, and `pnpm format:check` passed. `pnpm audit`
failed with 14 inherited advisories (7 high, 6 moderate, 1 low), including
`brace-expansion`/`undici` through `@earendil-works/pi-coding-agent` and dev-only
`nanoid`/`postcss`/`esbuild`; no dependency or lockfile change was authorized in this slice.

## 14. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Treating any final prose as a blocker is unreliable | Useful work could be misclassified | Only a deterministic `BLOCKED:` first-line marker is a blocker. |
| A dirty worktree masks a real failure | Parent may integrate partial/broken work as success | §7.2 gives cancellation, session errors, invalid Git, blockers, and required-response absence higher priority than worktree state. |
| A report call races a subsequent error/cancel | Model claim could hide host terminal fact | Capture report intent but settle only after session terminal observation. |
| Minimal mode silently changes existing profiles | Existing prompts/tests rely on `report_result` | Profile-level opt-in; absent field remains legacy; old logs remain readable. |
| Fingerprints or activity telemetry expose too much | Run logs become an uncontrolled prompt/tool-argument sink | Store hashes, bounded counters, bounded final summary, and bounded changed paths; never raw task card twice, tool arguments, or thinking. |
| Metrics are interpreted as quality proof | Incorrect protocol/model conclusion | Label all metrics descriptive; require matched fingerprints/projections and explicitly exclude causal/quality/precise-timing claims. |
| Projection or shell boundary regresses | Child gains authority beyond parent | Reuse #55 exact `E` and actual tool-surface/canary tests; minimal mode removes a tool and adds none. |
| Scope creeps into FSM parallelism or integration | Re-architecture or unsafe automation | Keep child lifecycle host-owned inside the parent pool; retain parent-only verification, commits, and integration. |

## 15. Changed files

This implementation changes the host delegation/terminal-inspection path, manifest
parsing/types, child records/roll-ups/stats, public type exports, and focused
manifest/host/cost tests. It adds no dependency, child process/shell/Git tool,
reducer/checkpoint/FSM transition, automatic integration, or README change.

## 16. Acknowledgement record

The overseer explicitly acknowledged all four decisions before implementation in
this run:

1. profile-level `completion_protocol: minimal` opt-in, with omitted profiles
   retaining `report_result` and its missing-report failure;
2. case-sensitive first-non-empty-line `BLOCKED:` grammar and its stable empty
   reason;
3. the complete §7.2/§7.3 precedence, including cancellation over session error,
   invalid Git over blocker/report, required-response absence over dirty state,
   and legacy report/worktree conflicts; and
4. distinct non-success `blocked` records plus the bounded additive evidence and
   limited cohort telemetry in §§8–9.

The acknowledged contract is implemented as described above; the remaining release
risk is the inherited `pnpm audit` advisory set in §13.
