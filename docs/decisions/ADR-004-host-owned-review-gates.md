# ADR-004: Host-owned review gates and recovery

## Status
Accepted

## Context
A reviewer must be able to approve or request changes without being able to
choose the next role, phase, or revision. Reviewer sessions can also terminate
without emitting a valid decision, and the reducer only accepts legal
hub-and-spoke transitions. These facts must remain durable across restart.

## Decision
- Declare opt-in review gates in the manifest under `review_gates`; validate
  their stable phase/gate identity and declared reviewer/owner roles before
  deriving the machine definition.
- Pin the selected gate and reviewed revision in a `review_gate_pinned` record
  at run start. Resume rehydrates that pin and rejects a conflicting override.
- Expose only bounded `approve({ reason })` and
  `request_changes({ reason })` terminal tools to the reviewer. The tools write
  to a session capture buffer; the host classifies, persists, validates the
  current revision, and routes.
- Treat a missing, duplicate, or malformed decision as durable
  `review_incomplete` state. Route the phase owner back to the gate with
  deterministic repair guidance.
- Route reviewer → orchestrator → phase owner through `reduce`. Persist a
  `review_route_pending` intent before that multi-snapshot bridge and a final
  `review_route` marker after it. Resume completes any interrupted hop without
  inventing a lifecycle event for a session already reconciled as failed.
- Approval fails closed when no current-revision provider exists or when the
  provider returns a different/unavailable revision.

## Alternatives considered

### Let the model emit a routed handoff
Rejected: it would allow the reviewer to author role, phase, and revision
identity and would bypass the host's pinned state and reducer checks.

### Mutate the checkpoint directly to the phase owner
Rejected: every state change must pass through the pure reducer, and direct
mutation would make replay/resume diverge from live execution.

### Store only the final route marker
Rejected: the reviewer-to-owner route crosses multiple reducer snapshots. A
crash between those snapshots would leave an unowned, un-routable checkpoint.
The pending intent makes the recovery point explicit.

## Consequences
Review gates add records and host configuration, but legacy manifests and
runs do not opt in and retain the existing machine-event path. A resumed run
without a current-revision provider cannot advance an approval until the host
supplies one; this is intentional fail-closed behavior.
