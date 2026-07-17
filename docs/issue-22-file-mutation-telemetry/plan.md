# Plan — Issue #22: Persist file-mutation telemetry

**Source:** GitHub issue [#22](https://github.com/lynellf/pi-conductor/issues/22).

## Objective

Make successful `write` and `edit` calls durable and replayable so analytics
consumers can report the files changed by a run without depending on the
in-memory display sink.

## Contract decisions

- Add one host-owned `file_mutation` `PersistedRecord` per successful `write`
  or `edit` invocation that yields valid touched-file metadata.
- Each record includes `run_id`, timestamp, role, SDK session identifier and
  session-file context, the tool name, and the touched files. Touched files
  retain the existing char-count additions/deletions and optional structured
  hunks contract.
- Build the persisted record from the same computed file metadata used for the
  display event, preventing the display and analytics views from drifting.
- Route the record through `Host.persistRecord`, not directly to a log. This
  preserves the durable-append-before-`conductor:record` emitter ordering.
- Failed tool executions and malformed mutation arguments produce no mutation
  record: they cannot truthfully identify a confirmed changed file.

## Tasks

### Task 1 — Persistence contract

- [x] Move the file-mutation value types to the pure persistence contract.
- [x] Add the replayable `file_mutation` member to `PersistedRecord` and export
      its public types.

### Task 2 — Host wiring

- [x] Have the shared session-event handler construct and persist the record
      after a successful `write` or `edit` event.
- [x] Wire both `ProductionHost` and `StubHost` through `persistRecord` so
      JSONL and record-emitter consumers observe identical records.

### Task 3 — Verification and documentation

- [x] Add focused tests for successful mutations, failure/malformed exclusion,
      and JSONL replay preservation.
- [x] Update the record-emitter contract and complete repository verification
      and code review.

## Risks

| Risk | Mitigation |
| --- | --- |
| Display and persisted metadata diverge | Build both from one `TouchedFile[]` value. |
| A direct log append bypasses `conductor:record` | Pass all mutation records to `Host.persistRecord`. |
| Historical run logs lack the new member | Replay remains additive: existing records deserialize unchanged. |
