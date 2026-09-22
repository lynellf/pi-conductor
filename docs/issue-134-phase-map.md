# Issue #134 — implementation phase map

**Authority:** Forgejo issue #134, *Standalone CLI runs are not durably
discoverable, resumable, or ledger-visible by default*.

## Decisions and boundaries

- **Durable default:** CLI-only behavior changes. The CLI resolves its omitted
  `baseDir` to `<cwd>/.pi-conductor/runs`; the library's omitted-`baseDir`
  temporary-directory behavior remains unchanged. The extension is not changed:
  it already uses this directory.
- **No unnecessary public API:** do not add a host/public-barrel export merely
  to share a CLI-only default. Keep the CLI resolver private to `src/bin/`.
- **Start event:** once `startRun` has resolved, write one documented NDJSON
  event to stdout in *both* modes:
  `{"schema_version":1,"event":"run_started","run_id":"…","log_dir":"…"}`.
  `log_dir` is absolute. `--json` therefore becomes an NDJSON stream: this
  event followed by its existing terminal JSON result. Text mode retains its
  existing human-readable terminal line after the event.
- **Resume:** add `conduct resume [options] <manifestPath> <runId>`. It passes
  the resolved directory and `goal: ""` to `resumeRun`; the host restores the
  original goal from durable `run_seeded` data. Do not weaken existing resume
  admission, reconciliation, pinned-manifest, or lease behavior.
- **Telemetry:** no direct network telemetry is added. The durable default log
  is the system of record and is eligible for the analytics plugin's existing
  later disk backfill.
- **Jev consent:** the operator explicitly approved this run's TypeSafe
  recipient-context enrichment and advisory phase-work-packet assessment. Both
  are advisory-only; neither changes routing, authorization, validation, or
  review approval. The disclosure is `docs/jev-context-ranking/operator-disclosure.md`.

## Phase map

### Phase 1 — CLI durable-directory contract

**Owned files:** `src/bin/cli-base-dir.ts` (new), `src/bin/cli-main.ts`,
`tests/bin/cli-base-dir.test.ts` (new), `tests/bin/conduct.test.ts`.

**RED:** add focused tests that prove a normal start passes the absolute
`<cwd>/.pi-conductor/runs` directory to `startRun`, and that `--log-dir` remains
an absolute explicit override. The existing direct-library `startRun` test must
continue to demonstrate its temporary default. Run:

```sh
pnpm exec vitest run tests/bin/cli-base-dir.test.ts tests/bin/conduct.test.ts
```

The new assertions must fail because the current CLI omits `baseDir`.

**GREEN/REFACTOR:** add the smallest private CLI resolver and pass its result
into the existing host factory and `startRun`. Preserve ordinary filesystem
errors from directory creation; do not add arbitrary control-character or
path-length policy. Verify the focused command is green, then run
`pnpm typecheck` and `pnpm lint`.

**Review gate:** independent review is required: default persistent location is
a user-visible CLI contract.

### Phase 2 — Immediate, documented start metadata

**Owned files:** `src/bin/cli-main.ts`, `tests/bin/conduct.test.ts`.

**Dependency:** Phase 1's resolved absolute `baseDir`.

**RED:** create a deferred-completion handle test showing that a successful
`startRun` writes the `run_started` NDJSON event before `completion()` settles;
cover text mode, `--json` NDJSON framing, the actual handle `runId`, and the
resolved absolute `log_dir`. The current implementation emits only after
completion, so this must fail for that reason. Run:

```sh
pnpm exec vitest run tests/bin/conduct.test.ts
```

**GREEN/REFACTOR:** emit exactly one start event immediately after `startRun`
returns and before signal registration/completion waiting. Preserve existing
terminal result semantics and stdout-write error handling. Run the focused
command, `pnpm typecheck`, and `pnpm lint`.

**Review gate:** independent review is required because `--json` framing is a
public CLI contract.

### Phase 3 — Supported resume command

**Owned files:** `src/bin/cli-main.ts`, `tests/bin/cli-resume.test.ts` (new),
and any narrowly extracted private CLI helper necessary to share host-factory
construction between start and resume.

**Dependency:** Phase 1's resolver; Phase 2's output convention.

**RED:** test help/usage, default and explicit log paths, manifest-not-found
exit 3, pass-through of the original `resumeRun` error as exit 1, `goal: ""`,
and start-shaped immediate/terminal output. The CLI dependency seam must inject
both `startRun` and `resumeRun`; tests must not call a real provider. Run:

```sh
pnpm exec vitest run tests/bin/cli-resume.test.ts
```

**GREEN/REFACTOR:** parse `resume` as a real command before ordinary start
arguments; invoke `resumeRun` using the same production host factory, resolved
base directory, model registry, signal handling, warning surface, and terminal
format as start. Do not create a new error class or bypass the host's resume
checks. Run the focused command, `pnpm typecheck`, and `pnpm lint`.

**Review gate:** independent review is required because this exposes a
persistence/recovery command.

### Phase 4 — Integration and final review

**Acceptance:** all six issue criteria are evidenced from the integrated diff:
durable default/override; immediate machine-readable discovery metadata;
supported resume; later disk-backfill eligibility; documented no-live-telemetry
decision; focused regression coverage while library defaults remain unchanged.

**Verification:**

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm format:check
pnpm audit
```

Run commands in the foreground; do not use shell timeout/detachment wrappers.
The final reviewer independently checks the issue, plan, diff, RED evidence,
all gate output, scope, and the telemetry decision.

## Failure-route table

| Trigger | Current role | Maximum retry | Legal next owner | Disposition |
| --- | --- | ---: | --- | --- |
| RED test passes or fails for setup/baseline reason | implementer | 0 | orchestrator | Block phase; correct test contract or escalate. |
| Implementer blocks or model chain exhausts | implementer | 1 | orchestrator → implementer | One bounded repair route, then operator escalation. |
| Reviewer requests changes | reviewer | 1 per phase | orchestrator → implementer → fresh reviewer | Remediate the same phase; never advance. |
| Reviewer decision is missing/malformed | reviewer | 1 | orchestrator → fresh reviewer | Fresh decision, then operator escalation. |
| Implementer/reviewer visit cap would be exhausted | orchestrator | 0 | operator | Use `/conduct:abort` and inspect durable log. |
| No legal target or `guard_failed` | current role | 0 | operator | Stop machine events; externally abort/escalate. |
| `end` is rejected | orchestrator | 0 | operator | Externally abort/escalate; do not retry an illegal event. |
| Interrupted run | operator | n/a | operator | Resume with `conduct resume <manifest> <runId>` and the durable log. |

## Topology

FSM roles are sequential: `orchestrator → implementer → orchestrator → reviewer
→ orchestrator`. There is no delegation and no parallel work: all implementation
phases modify `src/bin/cli-main.ts`, so parallel write ownership would be unsafe.
The orchestrator is uncapped; implementer and reviewer each have 8 visits,
sufficient for three initial phase visits, three bounded remediations, and two
additional final/integration routes. The orchestrator is the sole normal end
authority.
