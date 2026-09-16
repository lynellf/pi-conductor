# Sandboxed executable controller example

This example replaces an orchestrator model turn with two fixed Node executables:
`planner.mjs` selects the next durable action, and `adapter.mjs` writes a private
staging result. Both run only from an operator-approved runtime inventory.

The sequence is explicit in `planner.mjs`: prepare a packet, delegate one native
worker with that immutable packet as `host_artifact`, validate both the packet and
the worker's durable terminal record, read and decode the validation artifact, then finish.
The planner keeps receipts and references in its durable state because event pages
are incremental. The host retains admission, sandbox, artifact, receipt, and end
authority.

The real smoke test installs these files in an approved runtime as
`/opt/pi-conductor-example/*.mjs`, with Node at `/usr/bin/node`, and invokes the
rebuilt CLI entrypoint with a synthetic native-worker provider. It uses no paid
model or network service.
