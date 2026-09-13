# Issue #110 — Durable structured handoff delivery

## Contract and rationale

This repairs delivery under FSM spec §§8.4, 11.2 and 12 and the actionable
handoff contract in issue #21. An accepted worker envelope previously survived
only as field names and `reason` in the returning orchestrator's seed. Public
packet paths and hashes in other fields could disappear, and optional transcript
inspection could not reliably recover them.

The host stores a versioned `accepted_handoff` envelope on the accepted transition
itself, before its checkpoint snapshot. Its recipient must match the accepted
transition and payload target. This avoids a separate payload record and its
crash window. The reducer still treats payloads as opaque and owns routing;
transport validation does not introduce a new routing policy.

The complete compact JSON envelope has a 64 KiB UTF-8 limit. Unsupported JSON
values and over-limit envelopes receive explicit, non-terminating validation
errors before capture or sealing, so the emitter can correct the same handoff.
Large evidence belongs in the existing artifact path, with a concise locator
and measured hash in the envelope. No field is silently truncated to meet the
limit.

Both orchestrator and worker seeds receive the accepted structured fields,
including role-defined fields, from durable records. Model-authored `context_ref`
and `artifacts` remain excluded from the payload projection: predecessor identity
comes from host records, and artifact collection and verified delivery remain
authoritative. A custom path/hash field is ordinary model-authored content, not
proof of artifact verification. No source transcript is read for this delivery.

Resume restores the incoming envelope for the current recipient without replaying
the accepted transition or its effects. An already selected trajectory retains
its exact persisted seed. Legacy records without transport metadata and synthesized
handoffs retain their prior behavior; malformed metadata that is present is an
explicit error. Old runs cannot recover structured fields that were never stored.

## Implementation and verification

- [x] Reproduce missing worker-to-orchestrator fields in an actual recipient seed.
- [x] Persist bounded immutable envelopes and validate recipient binding.
- [x] Deliver structured fields in both directions and across disk reload/resume.
- [x] Cover repairable validation, legacy/synthesized compatibility, and artifact
      authority without transcript disclosure.
- [x] Complete independent review and repository checks; rebuild the linked CLI.

Verification: 2,745 tests across 256 files passed, including 19 dedicated transport
tests. Typecheck, lint, format check, build, and the production dependency audit
passed. Independent Terra review found no remaining actionable findings. The
existing CLI link resolves to this repository's rebuilt `dist/bin/conduct.js`.

No live application campaign is part of these automated transport checks.
