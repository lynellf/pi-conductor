# ADR-003: Trusted local programs extend the existing effect broker

Status: accepted for issue #117.

The built-in delivery implementation requires a fixed HTTP service. Operators
also need reviewed local programs that speak their forge API directly, observe
CI without occupying a process, and recover an interrupted publication safely.

Add an opt-in `local_program` authority to the existing host-owned broker. Preserve
its durable intent, immutable evidence, exact authority, resource conflict and
read-only reconciliation contracts. Separate execute and inspect invocations;
persist process admission and identity before releasing private protocol input.
Prove old-process settlement before inspect can resolve uncertainty. Program,
declared runtime closure and host driver identities are measured independently.

A local provider is privileged trusted code, not a new sandbox capability.
Repository/network declarations document reviewed authority; they cannot confine
that code. The provider owns forge-specific checks and postconditions. Credentials
use private stdin with a scrubbed environment. Generic results retain all input
audience restrictions, unlike the built-in fixed metadata receipts.

Add an optional bounded timer to existing controller wait decisions. Persist the
delay with the decision timestamp and derive the deadline on resume. Existing
native scheduling and event wakeups continue, including while CI is pending.
No second scheduler, sleeping provider or unbounded polling loop is introduced.

The consequences are explicit operator responsibility for a complete runtime
inventory and provider policy, reapproval after implementation replacement, and
fail-closed recovery when original process identity cannot be observed. These
costs preserve the host-owned safety boundary instead of implying confinement
that the runtime does not provide.
