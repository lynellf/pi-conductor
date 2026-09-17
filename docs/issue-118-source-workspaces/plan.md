# Host-managed source workspaces (#118)

The authorized issue supplies this enhancement's requirements. The FSM spec
§§9–12 remains authoritative: the host owns effects, admission, persistence,
and cleanup; source preparation does not approve or publish proposed code.

## Decisions and assumptions

- Add opt-in source repository registrations, selected and pinned with the
  controller definition. Resolve a requested ref once and durably bind the
  exact commit before materialization. An uncertain attempt is not replayed.
- Prepare an independent private Git repository and sealed source inventory.
  Patch admission checks provenance, audience, base, ordered digests and path
  authority. Parent refs, checkout and Git controls remain untouched.
- One opaque prepared source may be selected by an adapter or one delegated
  batch. Existing snapshot/projection and write policies still narrow access.
- Source and artifact bytes travel through verified filesystem mounts, with
  metadata in bounded JSON. Runtime approval is independent of source identity.
- Validators use the existing foreground sandbox supervisor. Their status,
  capture and cleanup are host evidence; none implies semantic approval.
- Validator scratch is ephemeral, with kernel-enforced tmpfs byte limits.
  Artifact input mounts are read-only; no request supplies a host mount path.
- Source preparation and consumption use existing controller capacity and
  durable receipts, without waiting for unrelated delivery effects.
- Patch preparation accepts bounded text Git patches. Binary patch expansion
  is not safely bounded yet and is rejected before staging.

## Implementation and verification

- [x] Closed source/action/adapter contracts and pinned authority; test omitted
  fields preserve existing behavior and changed authority revokes access.
- [x] Immutable source store: exact base, ordered patch verification, independent
  Git controls, bounded inventory, atomic publication, retained uncertain work.
- [x] Controller preparation dispatch, durable recovery and safe projections.
- [x] Source-aware sandbox adapters, bounded scratch, artifact files and actual
  execution evidence bound to the exact source identity.
- [x] Native worker admission and independent materialization from a prepared
  source, including durable source identity on queued tasks and resume.
- [x] Acceptance coverage with temporary Git: unapproved proposal, failing test,
  repair identity, overlapping consumers, explicit delivered-ref successor,
  large data, denied authority/escape/conflict, crash and cleanup uncertainty.
- [x] Public no-model runner harness, configuration excerpt, and source/runtime
  approval guide. The harness runs the production-host Bubblewrap tests and
  covers the temporary-Git large-source, exit-7, repaired exit-0, scratch
  quota-exit-23, identity, cleanup, independent native workers, and
  parent-immutability cases.
- [x] Independent correctness/security review; resolve required findings.
- [x] Typecheck, build, full suite, lint/format, audit and real Bubblewrap checks.
- [x] Rebuild and verify the linked local CLI; commit the reviewed changes.

## Verification results

- `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm format:check`, and
  `git diff --check` passed.
- Full unit suite: 3,345 tests across 338 files passed. The subsequently added
  compatible parallel-patch regression passed with all 16 source-store tests;
  typecheck also passed after that test-only addition.
- Real Bubblewrap suite: 51 tests across 17 files passed. The documented
  no-model example independently passed both real source-workspace scenarios.
- Production dependency audit: no vulnerabilities. The complete dependency
  audit reported one low and two moderate development advisories, with no
  high or critical advisories.
- An initial full unit run encountered an intermittent existing duplicate
  artifact-publication error; an initial sandbox run timed out in an existing
  bootstrap test. Focused checks and complete reruns passed without weakening
  assertions or changing the affected implementations to suppress the failures.
- The linked `conduct` resolves to this repository's rebuilt
  `dist/bin/conduct.js`; its help smoke check printed the expected usage
  (the CLI currently returns exit status 2 for `--help`).
