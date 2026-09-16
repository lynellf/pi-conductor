# Child outputs and authorized delivery

Controller runs can publish selected native-child bytes and request narrowly
approved Git or remote effects. Both features are opt-in. Existing controller
manifests retain their existing behavior when these fields are absent.

## Configure output access

Add identical `child_outputs` declarations to the repository controller config
and protected controller approval. Each declaration names one allowed native
profile, exact report paths, an optional patch selection, and explicit consumers:

```json
{
  "profile_id": "worker",
  "reports": [{
    "id": "test-report",
    "path": "reports/tests.json",
    "media_type": "application/json",
    "max_bytes": 32768,
    "consumers": [{ "kind": "native", "profile_id": "reviewer" }]
  }],
  "patch": {
    "id": "change",
    "paths": ["src/example.ts"],
    "max_bytes": 262144,
    "consumers": [
      { "kind": "native", "profile_id": "reviewer" },
      { "kind": "effect", "effect_id": "integrate" }
    ]
  }
}
```

Consumer principals can name the controller, a native profile, a fixed adapter,
or a registered effect. Grant every actual reader explicitly. Routing an opaque
reference does not grant permission to read its bytes. Give review evidence only
to its intended reviewers and effects; the controller can route private refs.
Adapter `output_consumers` declares its output audience. An effect adapter also
uses `source_consumers` for selected integrated source and `result_consumers` for
its typed result metadata. Set these explicitly in the matching repository and
operator adapter registration. Give the integration source to the fixed validator,
and permit result metadata to reach the controller or next fixed adapter as needed.
Selected source access is intersected with every input patch audience. Derived outputs also
retain the restrictions of private inputs, so an adapter cannot publish private
input bytes to a broader audience.
Include downstream evidence consumers in the source and patch audiences as well:
the validator cannot emit evidence to promotion or delivery if its source audience
excludes those effects. The example template demonstrates these intersections.

Runs with explicit output or effect policies redact child transcript, summary,
context, and capture fields from raw controller record reads, including reviewer
terminals. Legacy definitions without these policies preserve their previous
terminal contract. Effect journal records remain host-private in every case.

The host captures selected bytes after native cleanup and before recording the
terminal result. It publishes only after that authoritative terminal. Each
`child-output/v2` reference binds run, definition, child, task, accepted base,
producer, terminal identity, policy, byte digest, media type, and consumers.
`child_output_ready` announces durable references without including report bytes.
A sibling may continue executing while those references are consumed.

Limits are 15 reports plus one patch, 128 KiB per report, 512 KiB per patch, and
1 MiB total per child. Paths must be exact safe relative paths; traversal,
reserved metadata, symlinks, hardlinks, changed source identity, unexpected
changes, and oversize outputs fail explicitly. Capture requires the supported
private host-owned Git worktree layout and its accepted base. Reports are bytes,
not approval inferred from a child's completion status.

## Approve effects

An approved fixed adapter has `effect_id` and emits the built-in request schema
for that effect. Its sandbox has no credentials or general delivery capability.
The host verifies the immutable request and executes the registered implementation
only after matching the operator grant and durable action intent.

The protected registry's `effects` entries pin:

- The adapter and implementation IDs, measured implementation digest, and exact
  built-in request/result schema IDs and digests.
- The canonical repository path and measured repository fingerprint.
- Exact allowed refs, selected source paths for integration, required evidence
  producers and schemas, byte limits, and timeout.
- For delivery, one remote ID, exact origin and path, POST or PUT method, and
  one named credential source.

Use the built package's `measureBuiltinEffectImplementations()` and
`measureGitEffectRepository(path)` exports to obtain the implementation inventory
and repository identity. Use the matching inventory entry's IDs and digests;
do not substitute a version label for a measured digest. Schema exports
`effectRequestSchemaFor(kind)` and `effectResultSchemaFor(kind)` provide the
closed contracts to register. Rebuild before measuring the linked CLI installation:

```sh
pnpm build
chmod -R go-w dist
```

Implementation files must be owned by the operator or root and must not be group
or world writable. Measure through the same entrypoint and loader that will run
the application: built CLI approval measures `dist`, while a source-loaded Pi
extension measures its loaded source modules. Protect that source tree before
measuring source-loaded execution. The inventory includes the actual Node binary
and installed TypeBox runtime, so it does not depend on a package lockfile being
included in an installed package.

Changes to approved implementation bytes or scope require updated approval and
a new pinned definition; resume does not silently adopt changed authority.

`git_integrate` takes ordered reviewed patch refs from one accepted base and
performs three-way integration in isolated Git state. It publishes selected
source bytes tied to the resulting commit, then compare-and-swap updates the
approved integration ref. Compatible overlapping patches are supported;
conflicts produce an explicit failure. Repository validation must inspect the
combined selected source and emit evidence for that exact integrated head.

`git_promote` requires an approved source ref at the reviewed head and uses
compare-and-swap for the target ref. `deliver_ref` verifies the canonical source
ref, exact head, and required evidence before using its approved endpoint.
Evidence is resolved from immutable artifacts and checked against the real
producer and schema; request fields alone do not establish approval.

Repository programs own review criteria, combined validation, CI gates, and the
decision to request promotion or delivery. The host's evidence reader accepts
closed JSON with `schema_version: 1`, `verdict: "approved"`, and either
`subject_digest` for a patch or `subject_head` for a commit. The approved producer
must actually run the repository's review or validation policy before emitting it.
Native evidence uses the pinned report ID as its schema identity.

## Credential and endpoint contract

The protected registry maps `credential_sources` entries `{ "id", "path" }` to
host-only files. The file must be a private, owned regular file containing only
the token's printable ASCII bytes, without a trailing newline. The credential
source name is pinned; secret bytes and file paths are not published in controller
artifacts. Removing the mapping or changing its path invalidates the active
mapping. Credentials may be rotated in the same protected file.

Delivery uses a Bearer token and an idempotency key at the exact approved URL.
HTTPS is required except for the loopback test service. Redirects, ambient proxy
configuration, and ambient credentials are not used. This is a narrow HTTP
adapter contract, not a general Git push implementation: the endpoint must own
its publication policy and have access to the requested Git object. The request
carries the exact head and target identity, not a repository upload.

The endpoint must return the closed `deliver_ref` result with the exact observed
remote object, prior object, target, and idempotency key. Read-only GET at the
same endpoint and key supplies reconciliation. The local fake endpoint in the
[delivery example](../../examples/controller-delivery) demonstrates the protocol.
A service that cannot authoritatively answer whether an operation applied leaves
that operation uncertain.

## Recovery and concurrency

The journal records intent before execution and exact prepared postconditions
before canonical Git or network changes. Outcomes are `applied`, `not_applied`,
or `uncertain`. Applied effects publish typed result artifacts; an adapter's
request artifact is never a completed effect receipt.

Resume reconciles pending effects using exact Git refs or the endpoint's
read-only idempotency query. It does not replay a write to discover its outcome.
An authoritative non-application permits a subsequent repository decision;
uncertainty blocks conflicting effects until reconciled. Journaling alone does
not provide exactly-once network delivery. A lost persistence acknowledgement
stops the activation rather than inventing a second terminal record.

Effects that target the same resource serialize. Independent resources and
native admission remain available while a delivery is waiting. Abort and
revocation prevent new effects; observations about a previously attempted effect
still require durable settlement. Recovery either uses the original sealed child
bytes or records an explicit unresolved publication. It never reruns a child to
recreate evidence and never substitutes a mutable worktree path for an artifact.

Run the no-model acceptance smoke with:

```sh
pnpm exec vitest run tests/host/controller-delivery-example.test.ts
```

It uses temporary Git repositories, fixed repository programs, and a loopback
fake service. It performs no external publication and incurs no model usage.
