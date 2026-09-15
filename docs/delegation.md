# Worktree subagent delegation

← [Back to README](../README.md#documentation)

## Contents

- [Worktree subagent delegation](#worktree-subagent-delegation)
- [Configure a parent and profiles](#configure-a-parent-and-profiles)
- [Ask the parent to delegate](#ask-the-parent-to-delegate)
- [Nonblocking tasks and controls](#nonblocking-tasks-and-controls)
- [Settlement and recovery](#settlement-and-recovery)
- [Projection-aware child authority (Issue #52)](#projection-aware-child-authority-issue-52)
- [Read-only context artifacts (Issue #60)](#read-only-context-artifacts-issue-60)
- [Declarative profile projection policy (Issue #55)](#declarative-profile-projection-policy-issue-55)
- [Explicit sandbox snapshot workspace (Issue #111)](#explicit-sandbox-snapshot-workspace-issue-111)
- [Bubblewrap command sandbox (Issue #106)](#bubblewrap-command-sandbox-issue-106)
- [Child boundary and branch integration](#child-boundary-and-branch-integration)

Yes: `delegate` is a host-provided tool, but **only a role that explicitly opts
in receives it**. It is not an FSM transition and subagents are not conductor
roles: the parent remains responsible for reviewing the result and deciding
whether to integrate a child branch.

### Configure a parent and profiles

Add `delegate` and a `delegation` policy to the parent role, then define the
named child profiles at top level:

```yaml
version: 1
roles:
  - name: implementer
    max_visits: 3
    models: [anthropic:claude-sonnet-4-5]
    system_prompt: .pi/roles/implementer.md
    tools: [read, grep, edit, write, bash, handoff, end, delegate]
    delegation:
      mode: nonblocking
      allowed_subagents: [api-implementer, test-writer]
      max_children_per_session: 6
      max_parallel: 2
      context_artifact_limits:
        max_items: 8
        max_item_utf8_bytes: 8192
        max_total_utf8_bytes: 32768

subagents:
  - name: api-implementer
    models:
      - model: anthropic:claude-sonnet-4-5
        effort: high
    max_session_cost_usd: 2.00
    system_prompt: .pi/subagents/api-implementer.md

  - name: test-writer
    models: [anthropic:claude-sonnet-4-5]
    max_session_cost_usd: 1.00
    system_prompt: .pi/subagents/test-writer.md
```

`allowed_subagents` must name declared profiles without duplicates.
`mode` is operator-controlled: `blocking` waits for ordered child results and
`nonblocking` returns stable child handles after durable acceptance. New runs
default to `blocking` when it is omitted. The model may omit `mode` or repeat
the configured value for compatibility; a conflicting value is rejected before
admission. Existing manifests that relied on per-call nonblocking mode must
add `mode: nonblocking` before starting a new run.
`max_children_per_session` is the total child-task allowance for one parent
logical invocation, including model fallback; accepted queued tasks consume it,
and completion or cancellation does not refund it. `max_parallel` bounds concurrent
children across all submissions and cannot exceed that allowance. Profile names cannot collide with
FSM role names. The optional closed `context_artifact_limits` block applies per
task. Its defaults are exactly 8 items, 8,192 UTF-8 bytes per item, and 32,768
UTF-8 bytes total; hard maxima are 16, 32,768, and 131,072 respectively. All
three positive safe-integer fields are required when the block is present, and
the total cannot be smaller than the per-item limit. Bump `version` when
changing this policy or a profile.

The child profile's `system_prompt` is a normal prompt file. Tell it to make a
focused change and call `report_result`. The host supplies the child task and
its worktree path; do not put parent transcripts or FSM routing instructions in
the child prompt. A profile is file-only by default. An operator can opt a
profile into the Bubblewrap command boundary described below; the parent still
reviews the result and decides whether to integrate it.

### Ask the parent to delegate

The enabled parent calls `delegate` with one or more independent tasks:

```json
{
  "tasks": [
    {
      "id": "api",
      "subagent": "api-implementer",
      "objective": "Add the endpoint validation described in issue 42.",
      "expected_output": "A focused implementation and relevant unit tests."
    },
    {
      "id": "tests",
      "subagent": "test-writer",
      "objective": "Add edge-case coverage for the endpoint contract.",
      "expected_output": "Focused edge-case test changes."
    }
  ]
}
```

Task IDs match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; `objective` and
`expected_output` must each be 1–8,192 characters. The entire batch is
validated before any worktree is created. Delegation requires a clean primary
checkout (`git status --porcelain=v1 --untracked-files=all`) and a resolvable
`HEAD`; commit or stash ordinary and untracked changes first.

The configured blocking mode waits for all children and returns results in input
order. Each result contains its authoritative status, branch, worktree path,
base/head commits, session file, usage, summary, and any failure reason. `completed` requires
verified uncommitted changes in the child worktree; `no_changes` requires a
clean worktree at the batch base. A `completed` report without changes becomes
`no_changes`; an unexpected commit or invalid Git state becomes `failed`.

### Nonblocking tasks and controls

Configure `mode: nonblocking` in the parent role policy to return after the
whole batch has been durably accepted. Submit tasks without a mode argument:

```json
{
  "tasks": [{
    "id": "parser",
    "subagent": "api-implementer",
    "objective": "Implement the parser change.",
    "expected_output": "A focused parser diff."
  }]
}
```

For compatibility, a `mode` argument may repeat the configured value; a
contradictory value is rejected.

The response is `{"child_ids":["<stable-child-id>"]}` in input order. Use these
host-issued handles, rather than the task's `id`, for subsequent controls on the
same `delegate` tool. A control call contains `operation` and a nonempty
`child_ids` array; it cannot also contain `tasks` or `mode`.

| Call | Behavior |
| --- | --- |
| `{"operation":"status","child_ids":["<child-id>"]}` | Inspect queued, running, or terminal state immediately. |
| `{"operation":"result","child_ids":["<child-id>"]}` | Retrieve available durable results immediately; unfinished tasks retain their pending state. |
| `{"operation":"wait","child_ids":["<child-id>"]}` | Wait only for the selected children and return their results in requested order. |
| `{"operation":"cancel","child_ids":["<child-id>"]}` | Cancel selected queued/active children and await their settlement. |

`status`, `result`, and `cancel` return an array of objects with `child_id`,
`task_id`, `submission_id`, `status`, and a `result` when available. `wait` returns
`{"results":[...]}`. Terminal result fields use the same snake_case contract as
blocking submission. For compatibility, a missing session is an empty string and
unknown usage is an all-zero object in tool results; the durable log retains null
for both instead of asserting that usage was measured.

Controls consume no admission allowance and do not delete results. Unknown
handles reject. The parent can submit A and B, continue its own work, wait for B,
review B's result, and submit C while A is still running. All three share the
same concurrency and admission limits. An ordinary child failure leaves unrelated
children available.

The host queues brief child ID/status notifications through the parent's public
SDK steering interface at safe turn boundaries. These notices are advisory;
query the durable result before acting on it. The host does not start another
parent prompt from a child completion callback. Blocking delegation and explicit
result waits have no implicit RPC transport deadline; child executable tools
still use their configured [execution deadlines](execution-controls.md).

Acceptance pins the clean Git base, profile, prompt, context artifacts and exact
projection before queueing. Later parent commits or prompt edits do not change
queued work. The run log atomically records one `delegation_submission_accepted`
batch before returning handles. The run, logical parent invocation and actual SDK
tool-call ID identify that submission. Redelivery of identical arguments under
the same identity returns the original handles before recapturing the checkout;
changed arguments reject. A new model-issued tool call is a new submission.

### Settlement and recovery

A normal role handoff or end waits for all accepted children to settle. If work
is pending, the parent receives a correction listing handles and can wait or
cancel before emitting the transition again. Abort, budget exhaustion and parent
failure close admission and settle owned children before the parent terminal or
replacement. Model fallback retains spent admission and completed results.

An SDK-confirmed retry clears only the parent's intermediate model error and
retains its charged usage. A terminal parent cannot submit more work, including
calls queued before failure. Rejections report `host_terminated` with the concrete
cause and a bounded diagnostic; changing handoff arguments cannot repair a terminal
invocation. Accepted-child retrieval and cancellation remain available. See the
[parent retry repair](issue-112-parent-retry.md) for boundaries and regression evidence.

Completed results remain retrievable by the same parent role after fallback,
handoff and resume. Retrieval contributes no additional usage: the existing
`subagent_completed` or `subagent_failed` record is the sole terminal/accounting
authority. A queued cancellation has no SDK session and unknown usage.

Resume never resubmits accepted work. After checking executable ownership, it
records one cancellation with `delegation_interrupted` for each unfinished
accepted child, including tasks that never started. Historical unmatched child
starts retain the `recovered_child_lost` recovery reason. Worktrees and completed
results remain available for inspection and explicit follow-up tasks. Unknown
executable ownership or ambiguous persistence/cleanup stops progress instead of
claiming completion or starting replacement work.

### Projection-aware child authority (Issue #52)

Delegation remains concurrency **inside one active parent role**; it does not
create parallel FSM roles. A task may narrow its child workspace to exact files
that are currently materialized in the clean parent workspace:

```json
{
  "tasks": [
    {
      "id": "parser",
      "subagent": "api-implementer",
      "objective": "Implement the parser change.",
      "expected_output": "A focused parser diff.",
      "projection_paths": ["src/parser.ts", "tests/parser.test.ts"]
    }
  ]
}
```

`projection_paths` is an optional array of 1–64 safe repository-relative file
paths. Conductor captures the parent’s Git `H` (materialized) paths at its clean
base commit, rejects duplicates, unsafe paths, and paths outside that captured
set, and creates no child worktree when batch validation fails. For a sparse
parent, omitting `projection_paths` explicitly inherits its full materialized
set; for a non-sparse parent, omission retains the legacy full-child-worktree
behavior. An explicit subset is always applied and rechecked before the child
session starts.

A child cannot use `request_files` or `delegate`, and it cannot expand its own
projection. A file-only child has no shell. A Bubblewrap-enabled child gets
only the sandbox command tools described below. The parent must decide whether
to disclose more context before or in a later delegated batch. This keeps child
authority monotonic even when siblings run concurrently.

The run log records each accepted child's `parent_role`, `parent_visit_index`,
and effective `projection_paths` in `subagent_started`. Rejected batches append
a `delegation_validation_rejected` record with the parent identity, task IDs,
and typed validation errors; no child lifecycle record is created for such a
batch.

For a reusable broader sandbox profile, configuration constraints, and a real
two-batch experiment, see the [workspace preparation evaluation](issue-111-workspace-evaluation.md).

### Read-only context artifacts (Issue #60)

A task may also attach a small ordered text inventory without widening its file
projection:

```json
{
  "id": "parser",
  "subagent": "focused-implementer",
  "objective": "Implement the parser branch.",
  "expected_output": "A focused parser diff and tests.",
  "projection_paths": ["src/parser.ts", "tests/parser.test.ts"],
  "context_artifacts": [
    {
      "id": "api-contract",
      "source": "inline",
      "text": "ParserOptions.mode is exactly strict | lenient."
    },
    {
      "id": "acceptance",
      "source": "file",
      "path": "docs/contracts/parser-acceptance.md"
    }
  ]
}
```

Artifact IDs use the task-ID grammar and are unique within the task. Inline text
is measured as its exact UTF-8 bytes. A file source must be one exact safe path
in the clean parent's currently materialized Git `H`; the host checks that the
materialized source is a non-symlink regular file, then snapshots canonical
UTF-8 bytes from the immutable `B:path` Git blob. It does not trim, normalize,
fetch, glob, reopen the source while prompting, or add the path to
`projection_paths`. Duplicate IDs/file sources, unsafe or unmaterialized paths,
invalid text, races, unreadable sources, and item/total overflow reject the
whole batch before a worktree or child session exists.

The child receives one host-labeled compact JSON section in its prompt. Artifact
text is explicitly untrusted reference data: it grants no file, tool, shell,
network, mount, write, `request_files`, or integration authority and is not a
sandbox. A file artifact remains absent from the child worktree unless its path
is independently projected.

New `subagent_started.context_artifacts` records contain the ordered IDs,
provenance, UTF-8 byte lengths, and domain-separated SHA-256 digests. Inline text
is retained in this append-only audit record; do not put secrets there.
File-derived text is not copied into JSONL: its recorded base commit, exact path,
length, and digest reconstruct it. New no-artifact starts write an explicit empty
version-1 inventory; historical starts without the optional field mean “not
recorded” and are never rewritten.

### Declarative profile projection policy (Issue #55)

A subagent profile can require its own bounded child projection instead of
relying on a parent prompt alone:

```yaml
subagents:
  - name: focused-implementer
    models: [{ model: anthropic:claude-sonnet-4-5, effort: high }]
    max_session_cost_usd: 2
    system_prompt: .pi/subagents/focused-implementer.md
    workspace:
      projection:
        required: false
        allowed_paths: [src, tests]
        default_paths: [src/parser, tests/parser]
```

A profile `workspace` chooses either this `projection` block or the explicit
`snapshot` mode described below; combining them is rejected.
`required` is an explicit boolean; `allowed_paths` is a non-empty, duplicate-free
list of at most 64 safe repository-relative literals. A literal can name one
tracked file or a directory root, but it is never passed raw to Git as a glob.
The host expands roots only against the clean parent's current materialized Git
`H` paths, then sorts and deduplicates the exact resulting files.

With `required: true`, every task must provide a non-empty exact
`projection_paths` selection. With `required: false`, `default_paths` is
required and omission resolves to its host-expanded exact set. An explicit task
selection may only narrow those defaults; it cannot choose a merely allowed
sibling. In every case, the admitted set is non-empty, no larger than 64, and a
subset of both the policy authority and the parent's captured `H`. Empty or
over-large default expansion, unavailable parent authority, unsafe requests,
and over-broad requests fail the whole batch before a child worktree or session
exists. Profiles without this block retain the Issue #52 behavior above.

`subagent_started.projection_paths` stores the exact effective files, never the
policy roots. Rejected policy admission uses the existing
`delegation_validation_rejected` record. This is file-tool path confinement,
not an OS, credential, or network sandbox.

### Explicit sandbox snapshot workspace (Issue #111)

A reusable sandbox profile can select approved source/test roots without listing
all their import dependencies for each task. Choose an explicit snapshot instead
of `workspace.projection`:

```yaml
subagents:
  - name: project-worker
    models: [{ model: openai-codex:gpt-5.6-terra, effort: high }]
    max_session_cost_usd: 2
    system_prompt: project-worker.md
    completion_protocol: minimal
    workspace:
      snapshot:
        paths: [src, tests, package.json]
        max_files: 4096
    execution:
      backend: bubblewrap
      runtime_root: prepared-runtime
      writable_paths: [src, tests]
      network: none
```

Add this profile to the parent's `delegation.allowed_subagents` and give the parent
finite child and concurrency limits. Snapshot tasks **omit `projection_paths`**;
a supplied selection is rejected. The parent supplies the objective, likely areas
and verification expectations in the task packet. The child receives a compact
root/count summary and uses file tools to discover relevant files.

`paths` accepts 1–64 non-overlapping safe file/directory literals. Every root must
match a selectable tracked file in the clean parent's materialized checkout.
`max_files` is required, from 1 through 10,000; it bounds the expanded exact file
set at admission. Empty/unavailable roots, unsafe control paths and over-limit
expansion reject the batch before any child is accepted. A sparse parent's missing
files remain missing. Growth beyond the limit requires a new run with an explicitly
updated manifest; there is no automatic authority expansion.

Snapshot mode requires the [approved Bubblewrap setup](#bubblewrap-command-sandbox-issue-106).
Read-only/runtime dependencies must already be available beneath approved roots or
in the independently approved runtime. Fixed `execution.writable_paths` and all
excluded-descendant checks still apply. New files and generated outputs are allowed
beneath an admitted writable directory; an entirely new empty output root needs an
approved tracked descendant in the parent first. The file limit applies to the
initial snapshot, not as a live disk quota. Existing metadata, file-tool, command
output and final-ingestion bounds also remain in force.

Each admitted task pins its clean base, exact selection, roots, file limit and
sandbox identity. Later commits cannot change queued work. Restart verifies
retained metadata and uses the pinned manifest; current YAML is not substituted.
Unfinished children retain the existing cancellation/reconciliation behavior.
The parent explicitly reviews and integrates independent sibling patches, commits
a clean baseline, and can then submit later tasks using the same profile.

Existing exact/default projections retain their 64-file limit. Omitting `workspace`
continues to inherit the full materialized parent without this new snapshot policy;
it is not implicitly converted. Snapshot mode offers explicit root selection and a
file-count ceiling. It does not expose host home, Git control state, credentials or
sibling workspaces, and it does not identify secrets within operator-selected files.
See the [contract and verification](issue-111-snapshot-workspace.md) and the
[earlier comparison](issue-111-workspace-evaluation.md) for evidence and limitations.

### Bubblewrap command sandbox (Issue #106)

Command execution is an explicit per-profile opt-in. Add `execution` beside a
subagent's `workspace` policy:

```yaml
subagents:
  - name: focused-implementer
    models: [{ model: openai-codex:gpt-5.6-luna, effort: medium }]
    max_session_cost_usd: 2
    system_prompt: .pi/subagents/focused-implementer.md
    workspace:
      projection:
        required: false
        allowed_paths: [src, tests, package.json]
        default_paths: [src, tests, package.json]
    execution:
      backend: bubblewrap
      runtime_root: prepared-runtime
      writable_paths: [src, tests]
      network: none
      environment:
        PATH: /usr/bin:/bin
        LANG: C.UTF-8
      max_output_bytes: 67108864
    tool_execution:
      timeout_seconds: 300
      termination_grace_seconds: 2
      max_recoverable_timeouts: 2
```

Omitting `execution` preserves the file-only behavior and needs no Bubblewrap
installation or approval. For an opted-in profile, `runtime_root` is relative
to the manifest directory, and `writable_paths` must stay within the profile's
admitted projection. `network` is currently exactly `none`. The child receives
`bash` and `read_execution_output` in addition to its confined file tools.
Commands and file tools operate on the same private materialization; the host
validates and stages its final changed paths without giving the child ambient
Git authority.

The host operator must independently prepare four inputs before starting or
resuming an opted-in run:

1. Install an exact reviewed Bubblewrap build containing the required
   CVE-2026-87766 fix at a protected canonical absolute path. The binary must
   be a regular non-setuid file without file capabilities; its ancestors must
   not be writable by untrusted users. The host must permit the required user,
   PID, mount, network, IPC, and UTS namespaces while the runtime probe verifies
   the final restrictions.
2. Protect the primary checkout, its ancestors, and Git control files from
   group/other writes. Admission checks these paths and refuses an unsafe
   checkout. Review ownership and collaboration requirements before changing
   permissions; Conductor does not apply `chmod` or `chown` repairs.
3. Build a private `runtime_root` using only directories and regular files
   beneath the admitted roots `bin`, `sbin`, `usr`, `lib`, `lib64`, `etc`, and
   `opt`. Include `/bin/bash`, its absolute ELF interpreter and transitive
   libraries, and the compiled fixed probe at
   `/opt/pi-conductor/probes/capability-probe-v1`. Do not use symlinks or
   hardlinks. The approval must list every regular file, sorted by its relative
   path; an omitted or extra runtime file fails closed.
4. Create a host-owned approval document matching the exported
   [`sandboxHostApprovalSchema`](../src/host/execution/sandbox/host-approval.ts).
   Capture `binaryIdentity` from `lstat` of the installed executable and compute
   lowercase SHA-256 digests from the exact installed binary and runtime files.
   Approval IDs are operator audit identifiers, not substitutes for those
   measurements.

The closed JSON shape is:

```json
{
  "schemaVersion": 1,
  "binaryPath": "/protected/prefix/bin/bwrap",
  "approvedBuilds": [
    {
      "kind": "upstream-release",
      "release": "0.12.0",
      "binaryIdentity": {
        "device": 0,
        "inode": 0,
        "mode": 33261,
        "uid": 0,
        "gid": 0,
        "size": 0,
        "mtimeMs": 0,
        "ctimeMs": 0
      },
      "sha256": "<64 lowercase hex characters>",
      "approvalId": "reviewed-bubblewrap-build"
    }
  ],
  "bootstrapApproval": {
    "approvalId": "reviewed-runtime-inventory",
    "files": [
      { "path": "bin/bash", "sha256": "<64 lowercase hex characters>" },
      {
        "path": "opt/pi-conductor/probes/capability-probe-v1",
        "sha256": "<64 lowercase hex characters>"
      }
    ]
  },
  "probeApproval": {
    "approvalId": "reviewed-capability-probe",
    "sha256": "<same digest as the inventory probe entry>"
  },
  "getcapPath": "/protected/path/to/getcap"
}
```

The numeric identity values above are placeholders and the abbreviated
`files` array is illustrative; do not copy them as approval evidence. Populate
the array with the complete measured runtime inventory. `getcapPath` is
optional when the host can use the default protected observer. Store the final
JSON at a canonical absolute path as a current-user-owned, single-link regular
file with mode `0600`, under a directory whose ownership and permissions pass
the same protected-path checks. The loader rejects unknown fields, unsafe
paths, duplicate or unsorted runtime entries, and changed files.

For the standalone CLI, put the option before the manifest path:

```bash
conduct --sandbox-approval /secure/path/sandbox-approval.json \
  .pi/conductor.yaml "Implement and test the requested change."
```

For the Pi extension, start Pi with
`--conduct-sandbox-approval /secure/path/sandbox-approval.json`; both
`/conduct` and `/conduct:resume` read that flag. See the
[preparation procedure](issue-106-bubblewrap/test-runtime-proposal.md),
[recorded prerequisite evidence](issue-106-bubblewrap/test-runtime-results.md),
and [approved sandbox specification](issue-106-bubblewrap/spec.md) when
reviewing a host installation. These resources describe evidence and test
inputs; they do not approve another host's binary or runtime.

The sandbox uses fresh Linux namespaces, an empty root, read-only runtime and
project inputs, private writable paths, private temporary/home/run directories,
and no network interface beyond loopback. It adds no ambient host credentials
or writable host mounts; an operator remains responsible for secrets they
explicitly place in the approved runtime or projected files. It still shares
the host kernel and currently enforces no CPU, memory, process-count, or storage
quota. Keep command deadlines finite.

An ordinary command exit, including nonzero exit, is a tool result with numeric
status `0..255`; stderr and retained output remain available for repair. The
current Bubblewrap JSON status cannot distinguish a process killed by a signal
from a program that explicitly exits with the corresponding `128 + signal`
value, so durable signal classification is `unknown`. Host timeout and abort
remain separately recorded cancellation causes.

If restart finds an unfinished sandbox execution, inspect it without mutation:

```text
conduct reconcile-tools --log-dir <path> <run-id> --execution <execution-id>
```

Recovery is bound to the original sandbox origin and recorded namespace/init
identity. It never scans global process markers and never replays the command.
After independently stopping every verified owned process and inspecting
partial project/output effects, use the same exact execution ID with
`--confirm-cleanup --note "<operator note>"`. An execution with no durable
correlated `READY` record remains blocked and cannot be cleared by operator
confirmation. See [executable tool controls](execution-controls.md) for the
full confirmation contract.

### Child boundary and branch integration

Each file-only child receives `read`, `grep`, `find`, `ls`, `edit`, `write`,
and `report_result`, rooted in its generated worktree. Every child file tool
rejects absolute paths, `..` traversal, and paths that resolve through a symlink
outside that worktree; this is path confinement, not an OS or credential
sandbox. File-only children cannot call `run`, `bash`, `handoff`, `end`,
`ask_user`, or `delegate`; Bubblewrap-enabled children add only the command and
output tools above.

The parent receives the worktree path and branch, then owns testing, formatting,
builds, Git inspection, commits, and integration. For example, it may run
`pnpm --dir <worktree_path> test`, inspect `git -C <worktree_path> diff`, and
commit accepted changes. The conductor never performs those actions automatically.

The host creates `conductor/<runId>/<childId>` and keeps both branch and
worktree under the run state directory. It **never** merges, cherry-picks,
resets, deletes, or automatically cleans up a child branch. After reviewing a
successful result, the parent or operator explicitly verifies, commits, and
integrates it, for example:

```bash
pnpm --dir <worktree_path> test
git -C <worktree_path> diff
git -C <worktree_path> add --all
git -C <worktree_path> commit -m "Implement delegated task"
git cherry-pick conductor/<runId>/<childId>
```

Worktree confinement is a path-control boundary, not an OS, network,
credential, or process sandbox. Child failures do not cancel siblings. A run
abort settles queued and active children before the parent. See
[settlement and recovery](#settlement-and-recovery) for restart behavior.

Related page: [per-role isolated workspaces](workspaces.md#per-role-isolated-workspaces-issue-48) explains the parent role workspace and artifact lifecycle that delegation relies on.
