# Host-managed source workspaces

Source workspaces are an opt-in controller capability. A prepared workspace is
an immutable host-owned source identity that can be consumed by a validator or
delegated batch. Preparation resolves one approved `repository_ref` and records
the exact base, patch digests, inventory, and audience. It does not approve a
change, publish a change, merge a branch, or contact an external service.

The repository-side controller configuration selects approved source IDs. This
is a contract excerpt; `/validators/validate.mjs` is operator-approved code in
the pinned runtime and is not a file shipped by the example directory.

```yaml
source_repositories: [example-repository]
adapters:
  - id: fixed-validator
    runtime_id: source-runtime
    executable: /usr/bin/node
    argv: [/validators/validate.mjs]
    input_schema_id: validator-input-v1
    output_schema_id: validator-output-v1
    capability: read_only
    source_policy:
      source_ids: [example-repository]
      max_scratch_bytes: 4096
      max_file_input_bytes: 65536
      max_file_input_files: 8
      timeout_ms: 30000
```

The private host approval supplies `source_repositories` grants. Each grant
contains the repository identity and fingerprint, exact allowed `refs/...`,
exact path or subtree roots, audience, isolated Git view setting, source and
patch limits, aggregate workspace limits, preparation concurrency, and a
timeout. The complete selected grants are pinned into the controller
definition. On resume, changed or revoked grants fail closed because the
definition digest no longer matches.

`max_total_bytes` is a conservative retained-storage budget, including private
copies, Git metadata, failed or quarantined workspaces, and control records.
Size it for every retained workspace, not only the checked-out payload. The
host reservation is at least
`8 * max_source_bytes + 512 KiB * max_source_files` per workspace.
`max_source_files` counts regular file entries; traversed directories still
consume the Git/control allowance included by this reservation. For example, a
grant with 2 MiB / 100 files and `max_workspaces: 4` should choose a
`max_total_bytes` of at least 264 MiB (a 320 MiB grant leaves room for bounded
variance):

```yaml
max_source_bytes: 2097152
max_source_files: 100
max_workspaces: 4
max_total_bytes: 335544320
```

Every durably pinned preparation, including failed and uncertain attempts,
continues to count against that run's reservation. Deleting retained files does
not reset this count. A fresh action therefore cannot bypass the run's budget.

Preparation currently accepts text Git patches. Binary Git patches are rejected
before staging because their compressed bytes do not bound their expanded size.
The aggregate text patch payload must fit both `max_patch_bytes` and
`max_source_bytes`. Each intermediate patch result is checked against the source
file and byte limits before the next patch is applied.

The planner can request:

```json
{
  "kind": "prepare_source",
  "action_id": "prepare-1",
  "source_id": "example-repository",
  "repository_ref": "refs/heads/delivery",
  "patch_refs": [{
    "ref": "child-output/v2/...",
    "sha256": "...",
    "byte_length": 1234,
    "accepted_base": "..."
  }]
}
```

The host returns an opaque `source-workspace/v1/<sha256>/<sha256>` reference.
An adapter or delegated batch may carry one `source_workspace_ref`. Adapters
may also carry artifact references as `{ref, path}` entries; paths are safe
relative names mounted below fixed read-only `/inputs`. A source Git view, when
approved, is mounted read-only at `/source-git`. Validator scratch is a
kernel-enforced tmpfs at `/scratch`, bounded by `max_scratch_bytes`; `/tmp`,
`/home/sandbox`, `/run`, and `/dev/shm` receive the same per-mount cap. Source
validation has no disk writable staging area.

Private artifact input copies are removed after confirmed process cleanup or a
failure before execution. When cleanup is unconfirmed, the run retains
`source-adapter-inputs-<action-id>-*` with an action ownership note for host
inspection. Recovery never relaunches that invocation automatically.

When a repair reuses a proposal prefix, submit the complete original patch
prefix followed by the repair patch. The first patch may name the resolved
repository base or the exact synthetic head of the unpatched source workspace;
each later patch may name that base or the immediately preceding synthetic
prefix head. Omitting the prefix or naming another base is rejected, so replay
cannot silently apply a repair to a different source.

Validator stdout is host evidence. The host envelope binds execution status,
source identity, output digest, and cleanup evidence before any registered
optional payload schema is considered. A passing validator is evidence for a
later controller decision; it is never semantic approval by itself.

Preparation and consumption are recoverable lifecycle operations. The host
persists source intent before private Git mutation, then persists started and
prepared or failed evidence. An uncertain preparation is retained for
inspection and is never silently replayed. A fresh repair action produces a new
source identity. Reusing an identity is allowed for repeated reads when its
grant and audience still match. A successor must name a new explicit source
identity or delivered ref, and the runtime authority remains independently
pinned.

The public no-model check in
[`examples/controller-source-workspaces`](../../examples/controller-source-workspaces/README.md)
invokes the production-host Bubblewrap tests. The validator scenario prepares a
temporary repository with more than 1 MiB of source data, exercises a patch
whose validator exits 7, a repaired identity that exits 0, and a scratch quota
overflow that exits 23, then verifies source identity, cleanup evidence, and
parent-repository immutability. The native-worker scenario gives two independent
workers the same prepared source with separate Git controls and outputs. The
harness does not exercise a publication, delivery, or model-driven review workflow.
The executable scenarios are in
[`bubblewrap-source-workspaces.real.ts`](../../tests/host/bubblewrap-source-workspaces.real.ts)
and [`bubblewrap-source-workers.real.ts`](../../tests/host/bubblewrap-source-workers.real.ts).
