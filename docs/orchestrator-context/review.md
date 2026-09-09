# Orchestrator context retention review

Reviewed against the acknowledged #87 contract and `origin/main` at `7592fa4`.
Luna implemented the changes; the coordinating agent independently inspected
the lifecycle, filesystem, SDK and RPC boundaries and ran the verification.

## Decisions verified

- Manifest validation pins the opt-in policy and rejects incompatible worker,
  trajectory and Prewalk configurations. Historical absence keeps fresh sessions.
- Restoration checks the exact conversation, branch, hash and settled tool
  exchanges. Forking preserves the source file. Each attempt has a new logical
  identity while fallback preserves the execution visit used for admission.
- Context capture follows tool/delegation settlement. Boundary commitment follows
  the terminal record and confirmed session disposal. Failed startup releases
  acquired sessions and live registry entries.
- Current model, prompt and tools are applied to restored history. The shared
  default-model test verifies the provider's actual selected model. Compaction
  settings use an in-memory snapshot without rewriting settings files.
- Compaction starts are durable before provider requests. Actual summary usage
  joins invocation accounting exactly once; imported history is excluded.
  Unknown charges survive terminals and resets and block budgeted continuation.
- Reset takes the existing run lease and cleanup checks and preserves FSM state,
  costs, visits and accepted work. Inspection exposes references and status,
  without ordinary transcript dumps.

## RPC findings resolved

The retained child uses the public Pi runtime bootstrap and the real machine
tools extension. Retained terminal tools end the agent turn without requesting
early process shutdown. The prompt wrapper finishes metering and receives the
host acknowledgement before the host captures context and disposes the child.
Ordinary RPC shutdown behavior remains unchanged.

Strict bridge payloads separate raw SDK usage from normalized persisted usage,
verify their aggregate, and reject duplicate or mismatched lifecycle records.
Child statistics subtract their imported baseline. Settlement validates physical
identity and the durable history tip, and failures remain sticky.

Source-loaded extensions resolve the compiled child under the package's `dist`
directory. Real continuity tests use the production process launcher, verify
new physical identities, retained seeds and an unchanged source session file.

## Verification

Tests use deterministic providers, actual temporary session files and real local
RPC subprocesses. No paid provider run or SDK/dependency upgrade was needed.
Coverage includes persistence/corruption, shared and isolated continuity,
restart/reset, model fallback, current authority, successful and failed metered
compaction, unknown usage, oversized context, and startup/disposal failures.

Repository gates: `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`,
`pnpm format:check` and `pnpm audit --prod`. Mandatory pre-push hooks run lint,
typechecking and the full test suite again.

The remaining general module-size work is tracked separately in #88. The public
Pi runtime migration in #67 is not part of this change. Source checkouts require
`pnpm build` before launching the retained RPC child.

PR #91 merged on 2026-09-09 at `3f2e959`. Its source tree matches the reviewed
head exactly. The final pre-push run passed 2,263 tests across 208 files, lint and
typechecking; #87 is closed.
