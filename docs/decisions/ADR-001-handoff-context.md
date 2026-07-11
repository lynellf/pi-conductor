# ADR-001: Host-owned predecessor context for handoffs

## Status

Accepted

## Date

2026-07-11

## Context

Each role invocation runs in a fresh pi session. A concise handoff payload is
the normal boundary, but a recipient sometimes needs to inspect the session
that produced it. The reducer must remain payload-blind and the host-owned
`run_id`-keyed session log must remain the source of truth.

## Decision

Accepted handoffs carry an additive, host-generated `context_ref` containing
`run_id`, `source_role`, and `source_session_file`. The loop derives it from
the live role/session, never from model payload fields, and includes it in the
recipient seed and orchestrator `last_message`.

Recipients get an optional no-argument `handoff_context` tool bound to that
single reference. It opens the predecessor with pi's `SessionManager` and
uses `buildSessionContext()` so branch and compaction behavior matches pi.
The returned serialized context is bounded to 10,000 message characters and
is not injected automatically. Synthesized handoffs bind no source and
surface an explicit unavailable reference.

Older records derive the same reference from their existing role/session
fields; synthesized sentinel paths remain unreadable. The `context_ref`
field is therefore additive and resume-compatible.

## Alternatives considered

### Inject the full predecessor transcript into every prompt

Rejected: it increases prompt size and removes recipient control over when
historical context is needed.

### Let the recipient supply a session path to a generic reader

Rejected: it would grant arbitrary cross-run/session access and make model
payload responsible for provenance.

### Put the reference in reducer state or reducer decisions

Rejected: provenance is driver context, not machine state; adding it would
violate the reducer's payload-blind, deterministic boundary.

## Consequences

- Handoffs remain compact by default while recipients without filesystem tools
  still have a read-only context path.
- The host must wire the tool only for a referenced recipient session and must
  preserve the reference across resume.
- Session files remain outside pi's session tree and are read through the
  supported SDK session APIs.
