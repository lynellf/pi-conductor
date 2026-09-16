# ADR-002: Immutable child outputs and a host-owned effect broker

Status: accepted under issue #116.

Date: 2026-09-16.

## Context

Repository controllers need to route one settled child's actual bytes to a
reviewer while siblings continue. They also need reviewed integration and
delivery without exposing host credentials or unrestricted commands to a
repository executable. A child completion record alone establishes neither
source identity nor approval. Process failure during a remote write also leaves
an outcome that cannot safely be inferred from a missing receipt.

## Decision

Publish selected native bytes in a separate immutable `child-output/v2`
namespace. Capture follows owned cleanup; the authoritative child terminal binds
the capture, and a later publication record makes the sealed refs consumable.
Explicit principal grants accompany each artifact, and private input restrictions
follow derived output. Resume uses those original sealed bytes or fails visibly.

Keep repository adapters sandboxed. An effect-backed adapter emits a closed
request artifact; the production host matches that artifact to the real action,
measured implementation, schema, and exact operator grant. The broker owns only
the mechanical integration, ref compare-and-swap, authenticated endpoint request,
and observation of exact postconditions. Repository programs retain scheduling,
review semantics, validation, CI policy, and the choice to publish.

Record effect intent before execution and prepared postconditions before canonical
mutation. Separate effect resource lanes from adapter slots so a slow delivery
does not hold native admission. Conflicting resources serialize. Ambiguous
execution or persistence remains unresolved until read-only reconciliation; the
host never blindly replays a remote write.

## Alternatives considered

Passing mutable worker paths to reviewers would lose the exact source and cleanup
boundary. Reconstructing artifacts from transcript text would not prove which
bytes were reviewed. Granting network or Git commands directly to adapters would
move credentials and durable-effect ownership outside the host. Treating a
missing success receipt as failure would permit duplicate publication after a
lost acknowledgement.

## Consequences

Private evidence can be routed without disclosure to the controller. Stored
artifacts and their audiences become part of the resume contract. Exact
implementation and scope pinning means upgrades require operator reapproval;
a resumed definition cannot silently gain authority. Git conflicts and unsupported
output layouts fail explicitly. The remote service must support authoritative
idempotency queries; local journaling does not promise exactly-once delivery.

See the [operator guide](../issue-116-delivery/operator-guide.md) for supported
limits, endpoint behavior, and approval migration.
