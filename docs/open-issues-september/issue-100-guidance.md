# Issue #100 implementation checklist

This slice records the model guidance and operator documentation for the
supervised executable-tool recovery contract. Background-job handling remains a
guidance boundary; it is not a shell parser or a separate job API.

## Acceptance mapping

- [x] `src/host/execution/supervised-tools.ts` derives the visible bash deadline
  from `policyFor(options)` and publishes the guidance through `description`,
  `promptSnippet`, and `promptGuidelines` for shared and isolated wrappers.
- [x] Guidance requires foreground completion, names `nohup`, `&`, `setsid`,
  and `disown`, permits a shorter per-call timeout up to the pinned maximum,
  and requires a new finite owner limit or bounded split for longer work.
- [x] Guidance requires inspecting partial effects and forbids automatic replay;
  a background launch may still end with cleanup unconfirmed.
- [x] `tests/host/supervised-bash-guidance.test.ts` covers the dynamic pinned
  deadline and all model-visible recovery guidance. The initial RED run failed
  because the SDK description had no pinned deadline or recovery guidance.
- [x] `docs/execution-controls.md` documents correlation of run, execution,
  tool-call and tool identities; process start ticks, groups, ownership, PID
  reuse, original namespaces, actionable `/proc` visibility requirements, and
  bounded cleanup diagnostics (`cleanup_cause`, `leader_observed`, and up to 32
  observed Linux process members without command or environment data).
- [x] `package.json` and `CHANGELOG.md` identify release `0.21.4` and issue
  #100 behavior.
- [x] Runtime records optional cleanup causes and observed process identities
  with the documented meanings and limits. Forced missing-admission handling
  takes the true fast branch, and cleanup teardown validation is covered.

## Verification gates

- [x] Full suite: `pnpm test` passes 201 files and 2,105 tests. Typecheck,
  build, lint, format check, production audit, and frozen-install build pass;
  the audit reports no vulnerabilities.
- [x] Packed bash checks pass for Node 22.19.0 and 26.5.0 with Pi 0.80.6 and
  0.85.1. Packed file checks pass for Node 26.5.0/Pi 0.80.6 and Node
  22.19.0/Pi 0.85.1.
