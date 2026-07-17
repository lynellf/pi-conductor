# Plan — Issue #21: Actionable handoff contracts

**Source:** GitHub issue [#21](https://github.com/lynellf/pi-conductor/issues/21).

## Objective

Reject an ordinary handoff that lacks a minimally actionable work contract
without advancing the checkpoint or sealing the emitting role session. The
emitter can correct the handoff in that same session.

## Contract decisions

- Reserve four non-empty envelope fields on every model-emitted handoff:
  `status` (`ready`, `blocked`, or `complete`), `objective`, `summary`, and
  `requested_action`. Preserve `target_role`, `reason`, `suggests_next`, and
  arbitrary role-defined fields.
- Validate whitespace as empty. This is host/seam validation; the reducer keeps
  `MachineEvent.payload` as `unknown` and does not inspect handoff content.
- A failed completeness check records its missing fields in the session seam,
  returns a non-terminating error, and does not add a machine-event capture or
  seal the session. The loop persists the failure for observability before
  processing any corrected handoff.
- Host-synthesized handoffs bypass the model-emitted envelope contract.

## Tasks

### Task 1 — Seam contract and retry path

- [x] Define the reserved envelope and a pure actionable-handoff validator.
- [x] Have the `handoff` tool reject incomplete or whitespace-only envelopes
      without capturing, sealing, or terminating the session.
- [x] Record rejected attempts in `SessionSeam` for loop-owned persistence.

**Verification:** focused seam and tool tests cover missing and whitespace-only
fields, the actionable error list, and a corrected same-session handoff.

### Task 2 — Persistence and loop observability

- [x] Add a host-owned validation-rejection record with role/session metadata
      and missing fields.
- [x] Persist those records without `transition_accepted`, checkpoint changes,
      or lifecycle termination; leave existing resume behavior tolerant.

**Verification:** a loop test covers orchestrator-to-worker and
worker-to-orchestrator corrected handoffs, plus a synthesized-handoff path.

### Task 3 — Contract consumers and documentation

- [x] Update default prompts, fixture emissions, and schema documentation to
      use the envelope.
- [x] Update the governing handoff contract documentation and this plan.
- [x] Run focused and repository verification gates.

## Verification

- `pnpm test` — 802 tests passed, including same-session correction from both
  orchestrator-to-worker and worker-to-orchestrator handoffs.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build` — passed.
- `pnpm audit --prod` — completed but reports seven inherited `undici`
  advisories (three high) through `@earendil-works/pi-coding-agent`; this
  change adds no dependency and does not remediate that separate release blocker.

## Risks

| Risk | Mitigation |
| --- | --- |
| Existing test scripts omit envelope fields | Update scripts deliberately and retain full-suite regression coverage. |
| Validation failure accidentally becomes a session breach | Keep it out of the machine-event capture buffer and assert the session stays unsealed. |
| Envelope leaks into reducer policy | Keep validation in `src/seam`/`src/host`; reducer receives only opaque payloads. |
