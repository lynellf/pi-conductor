# Worktree subagent delegation

← [Back to README](../README.md#documentation)

## Contents

- [Worktree subagent delegation](#worktree-subagent-delegation)
- [Configure a parent and profiles](#configure-a-parent-and-profiles)
- [Ask the parent to delegate](#ask-the-parent-to-delegate)
- [Projection-aware child authority (Issue #52)](#projection-aware-child-authority-issue-52)
- [Read-only context artifacts (Issue #60)](#read-only-context-artifacts-issue-60)
- [Declarative profile projection policy (Issue #55)](#declarative-profile-projection-policy-issue-55)
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
`max_children_per_session` is the total child-task allowance for one parent
session; completed children do not free a slot. `max_parallel` bounds concurrent
children and cannot exceed that allowance. Profile names cannot collide with
FSM role names. The optional closed `context_artifact_limits` block applies per
task. Its defaults are exactly 8 items, 8,192 UTF-8 bytes per item, and 32,768
UTF-8 bytes total; hard maxima are 16, 32,768, and 131,072 respectively. All
three positive safe-integer fields are required when the block is present, and
the total cannot be smaller than the per-item limit. Bump `version` when
changing this policy or a profile.

The child profile's `system_prompt` is a normal prompt file. Tell it to make a
focused change and call `report_result`. The host supplies the child task and
its worktree path; do not put parent transcripts or FSM routing instructions in
the child prompt. The child is file-only: the parent alone runs commands,
verifies results, commits, and reconciles a retained child worktree.

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

The tool waits for all children and returns results in input order. Each result
contains its authoritative status, branch, worktree path, base/head commits,
session file, usage, summary, and any failure reason. `completed` requires
verified uncommitted changes in the child worktree; `no_changes` requires a
clean worktree at the batch base. A `completed` report without changes becomes
`no_changes`; an unexpected commit or invalid Git state becomes `failed`.

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

A child cannot use `request_files`, `delegate`, or a shell. It cannot expand its
own projection: the parent must decide whether to disclose more context before
or in a later delegated batch. This keeps child authority monotonic even when
siblings run concurrently.

The run log records each accepted child's `parent_role`, `parent_visit_index`,
and effective `projection_paths` in `subagent_started`. Rejected batches append
a `delegation_validation_rejected` record with the parent identity, task IDs,
and typed validation errors; no child lifecycle record is created for such a
batch.

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

For this profile-only `workspace` block, `projection` is the sole valid field.
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

### Child boundary and branch integration

Each child receives only `read`, `grep`, `find`, `ls`, `edit`, `write`, and
`report_result`, rooted in its generated worktree. Every child file tool
rejects absolute paths, `..` traversal, and paths that resolve through a symlink
outside that worktree; this is path confinement, not an OS or credential
sandbox. Children cannot call `run`, `bash`, `handoff`, `end`, `ask_user`, or
`delegate`.

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
abort cancels active children and then the parent; resume marks in-flight
children as cancelled (`recovered_child_lost`) rather than relaunching them.

Related page: [per-role isolated workspaces](workspaces.md#per-role-isolated-workspaces-issue-48) explains the parent role workspace and artifact lifecycle that delegation relies on.
