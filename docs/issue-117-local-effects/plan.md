# Approved local effect programs (#117)

Status: implemented and verified. Issue #117 is the authorized behavior and
acceptance scope; this plan records implementation choices under that scope.
The FSM spec §§10–12 and existing #115/#116 host ownership remain authoritative.

## Decisions and boundaries

- Add an opt-in `local_program` provider to the existing effect broker. Preserve
  built-in grant and journal formats by default; do not add another scheduler.
- Operator registration fixes executable/arguments, protected implementation and
  dependency identities, schemas, named operations, repository/ref authority,
  conflict resources, credential/network authority, and execution/output limits.
- Provider code is privileged trusted implementation. Host validation of a
  repository or network name is not OS sandbox confinement. Programs own their
  forge policy, required checks, exact remote identities, and authoritative inspect.
- Execute one bounded step. A successful observation of CI pending is completed
  work; ambiguous writes stay uncertain and block conflicting resources. Recovery
  must establish old-process settlement before inspecting or admitting new work.
- Keep explicit credentials in a private invocation channel with a scrubbed
  environment. No argv credentials, ambient auth, raw stderr, or model access.
- Reuse immutable evidence and actual consumer checks. Generic provider results
  retain input audience restrictions because they can contain repository data.
- Add optional bounded delayed `wait` decisions. Persist the delay with the
  decision timestamp, derive its deadline on resume, and use one cancellable timer
  while still processing child and artifact events. No sleeping provider or busy
  polling is required. Existing indefinite waits retain their meaning.

## Implementation and verification

- [x] Add closed contracts, exact approval validation, and durable journal checks.
- [x] Add protected program measurement, bounded execution, credential isolation,
  descendant cleanup, and read-only inspection with crash-safe process identity.
- [x] Wire production broker execution/recovery and private result publication.
- [x] Add bounded durable observation wakeups and verify event/abort/resume behavior.
- [x] Add complete fixed-program/fake-forge example covering publish/reuse, CI
  pending, successor completion, exact-head/check rejection, merge verification,
  recovery, uncertainty, resource lanes, and invalid/revoked authority.
- [x] Independently review authority, cleanup, evidence privacy, and crash ordering.
- [x] Run typecheck, build, full tests, lint, format check, and production audit.
- [x] Rebuild the linked CLI and record operator migration/trust limitations.

Terra owns contracts, approval, and ledger validation. Sol owns the trusted
execution boundary. Root owns integration, wakeups, and final gates; Terra also owns the example.
All verification uses local temporary repositories and controlled services;
external publication, campaign launch, and paid model calls are excluded.
