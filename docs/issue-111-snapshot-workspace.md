# Issue #111 — Explicit sandbox snapshot workspace

Status: Implemented and verified (2026-09-14), following owner approval.

## Objective and scope

Provide one explicit, reusable sandbox profile for approved source/test roots whose
import closure exceeds 64 files. A parent can discover later work and submit new
batches against a clean committed baseline without enumerating every dependency or
rewriting profiles. This implements the broader-workspace alternative in #111.
The [earlier evaluation](issue-111-workspace-evaluation.md) establishes mechanics,
but does not establish a productivity improvement.

This supplements the host contract under the FSM specification §§2, 8, 10–12.
It adds no reducer behavior, task-specific write permissions, scheduler, runtime
installation, network access, or automatic integration.

## Configuration

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

`workspace.snapshot` and `workspace.projection` are mutually exclusive closed
configuration shapes. Snapshot mode requires explicit Bubblewrap execution and
an available host-approved sandbox adapter. Omission and all existing projection
policies retain their semantics, including the 64-file explicit/default limit.
A manifest version bump opts a new run into the new policy.

Snapshot `paths` contains 1–64 safe repository-relative file/directory literals.
Absolute paths, traversal, glob syntax, Git/control-state segments, duplicates
and overlapping roots are rejected. Each root must match at least one selectable
materialized file at admission; unavailable roots fail with an actionable typed
error rather than silently disappearing. `max_files` is a required safe integer
from 1 through 10,000. There is no implicit increase of the ceiling when a later
batch grows. This is a file-count limit, not a new byte or disk-space quota;
existing byte bounds on command output, file tools, metadata and ingestion remain.

Tasks using snapshot profiles omit `projection_paths`. Supplying that field is a
typed pre-admission error, so selecting snapshot mode does not silently ignore a
request to narrow authority. Exact-file tasks continue to use projection profiles.

## Admission, authority and recovery

1. Capture the clean parent's Git base and selectable materialized files through
   the existing trusted sandbox path. A sparse parent's omitted files remain
   unavailable; roots never grant access beyond that captured parent authority.
2. Expand profile roots to a sorted unique exact set. Reject an empty selection,
   unavailable root or file-count overflow before acceptance or child creation.
3. Resolve fixed `execution.writable_paths` against that exact set and complete
   tracked metadata. Keep excluded-descendant rejection, read-only source handling,
   private sibling materializations and validated patch ingestion unchanged.
4. Pin the exact selection, profile fingerprint, prompt and sandbox descriptor
   through durable admission. Add snapshot-only metadata to the pinned sandbox
   policy (mode, configured roots, max_files), covered by its existing digest, so
   validation can recheck the count and root boundaries. Legacy policies omit this
   metadata and retain their existing behavior. A later parent commit cannot alter
   a queued task. Later new tasks capture their own clean base under the same profile.
5. Recovery checks the captured identity, snapshot-only limits and authority; it
   does not re-expand roots against a changed checkout. Existing pinned-manifest
   resume ignores current YAML changes, and unfinished accepted children receive
   the existing cancellation/reconciliation treatment. Tests must show that the
   pinned mode survives serialization, invalid retained limits fail closed, and
   current YAML cannot reinterpret admitted or future resumed work.

New files are allowed only under already admitted writable directory roots.
A wholly new empty output directory must first gain an approved tracked descendant
in the parent baseline. Runtime dependencies are still independently prepared and
approved. Transitive source/test dependencies are visible only if they fall under
the configured roots. Host home, credentials, sibling workspaces and private
control/evidence directories remain outside the sandbox. Snapshot roots do not
classify tracked secrets: the operator owns the disclosure choice.

## Prompt and integration

For snapshot profiles, prompt assembly reports configured roots and admitted file
count, alongside the existing objective, expected output and tool contract. It
does not append every exact filename. The exact inventory remains authoritative
host data, and prompt hints cannot widen it. Existing minimal and legacy profile
prompts retain their semantics.

Parent review and integration remain explicit. Concurrent children may have the
same permitted roots but operate on separate private snapshots. Integration must
check conflicts and semantic correctness, commit the approved result, then submit
later work against the resulting clean baseline.

## Implementation and verification plan

- [x] Manifest contract: add an exclusive snapshot shape, parse/freeze it, validate
  roots, limits and sandbox requirement. Table-driven manifest tests cover valid
  configuration, malformed/mixed blocks, denied roots and legacy compatibility.
- [x] Admission: add pure snapshot resolution to batch validation, pass roots to
  writable authority and extend the existing pin with snapshot-only metadata. Test
  >64 files, parent
  sparsity, missing roots, limits, explicit task-selection rejection, whole-batch
  failure and unchanged narrow behavior.
- [x] Prompt and durable contract: compact snapshot summaries in both completion
  protocols; verify persisted selection/fingerprint/limits and restart behavior
  without re-expansion. Add representative prompt and recovery tests.
- [x] Real sandbox evidence: extend the two-batch fixture with an explicit snapshot
  mode, evolving requirements, concurrent repair, new writable files, denied
  unrelated paths and explicit integration. Reuse approved prerequisites only.
- [x] Document configuration and actual limits/results, run checks, review the
  implementation, commit it and rebuild the linked CLI for local testing.

Pure configuration lives in `src/manifest`; admission and prompt changes live in
`src/host/delegation`. Extend `src/persistence` sandbox policy with optional
snapshot-only metadata; leave existing exact-set records compatible. Tests belong
in `tests/manifest` and `tests/host`. Strict
TypeScript, TypeBox where schemas are required, named exports and Biome conventions
apply; no new dependencies are planned.

Verification commands:

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm run audit
PI_CONDUCTOR_BWRAP="$APPROVED_BWRAP" \
PI_CONDUCTOR_BWRAP_SHA256="$APPROVED_BWRAP_SHA256" \
PI_CONDUCTOR_BWRAP_RUNTIME="$APPROVED_BASH_RUNTIME" \
pnpm exec vitest run tests/host/bubblewrap-workspace-cycles.real.ts \
  --config vitest.sandbox.config.ts
```

Run ordinary process-observation tests and real-sandbox experiments sequentially.
Always verify denial and recovery behavior before declaring completion. The owner
acknowledged this contract before implementation, as required by AGENTS.md. Never broaden an existing run, grant runtime approval from self-generated
measurements, change source-checkout permissions, or credit fixture success as
accepted application throughput.

## Design review

Terra reviewed the proposed boundary before implementation. Its actionable findings
were incorporated: resume must honor the pinned manifest rather than compare current
YAML; snapshot limits need durable metadata rather than admission-only enforcement;
reserved control-path segments must fail before admission; both prompt branches
need compact snapshot summaries. All four become explicit verification cases.

## Implementation evidence

The new real-sandbox mode admitted 68 files per child in its first batch and 70
in its second, under one unchanged 100-file profile. Both concurrent workers
created or changed files, inspected failed checks, repaired them, and returned
attributable changes for explicit parent integration. Verification also checked
that excluded documentation and control paths were absent and dependencies stayed
read-only. The existing broad and narrow modes passed alongside it.

Public `startRun`/`resumeRun` tests round-trip the manifest through disk and retain
snapshot roots/limits despite wider or malformed current YAML. Policy tests reject
inconsistent retained snapshot metadata even after its digest is recomputed, while
legacy full-materialized records keep their previous semantics. These tests cover
metadata and public resume; they do not claim that interrupted child models are
restarted in place. Existing reconciliation cancels unfinished children.

Implementation review found that resume also needed to reparse the retained
workspace's closed shape before constructing a host. Three regressions first
reproduced acceptance of mixed modes, a string in place of the root array, and an
unknown snapshot field; all now reject before host construction. Admission also
rejects mixed modes supplied directly by programmatic callers. Two admission-store
tests strip snapshot metadata and recompute its digest, with and without rewriting
the stored descriptor: both fail against the independently retained accepted
descriptor. Terra's follow-up review approved these authority and persistence
boundaries.

Final verification passed: 2,801 tests across 260 ordinary test files, all three
real Bubblewrap workspace scenarios, strict typecheck, build, lint, format check,
and production dependency audit (no known vulnerabilities). The first full-suite
attempt stopped on a Vitest worker RPC timeout; a complete rerun passed in 263
seconds. The linked `conduct` executable resolves to this checkout's rebuilt
`dist/bin/conduct.js`.

This enhancement adds explicit authority configuration and bounded worker prompts.
It does not change the earlier comparison's inconclusive accepted-work result.
