# Operator-approved local effect programs

`local_program` extends the existing controller effect broker. A sandboxed adapter
emits an immutable request; the host invokes a fixed, operator-reviewed program.
Existing configuration schemas and built-in Git/HTTP effects remain supported.
Local programs are opt-in in the protected host approval's `effects` array. As with
any rebuild, changed measured file identities require refreshed operator
approval, including existing built-in grants whose measured host closure changed.
The host does not silently accept old hashes or update approvals.

## Trust boundary

A provider is privileged host code running as the host user. It can open host
files and use the network. Its declared repository and `allowed_origins` are
reviewed authority, **not filesystem or network confinement**. The provider must
enforce those restrictions and its own forge policy: repository identity, exact
remote heads, required checks, reviews, branch rules, and merge postconditions.
The sandboxed controller/adapter receives none of that host authority. Providers
must read the invocation before performing effects, remain bounded, and must not
daemonize or deliberately escape process ownership tracking (for example by
creating another session while removing the supervision marker). Reap all children
before returning; do not leave detached background work behind.

Use a protected fixed executable and fixed arguments. Inventory every dependency
that influences behavior, including scripts, configuration, interpreter/runtime
files and dynamically loaded modules. The host measures declared files; it does
not discover an arbitrary program's complete dynamic dependency closure. Review
that closure before approving it. Files must be canonical regular files, owned
by the operator or root, without group/world write access. Replacing the provider,
a dependency, or the measured host driver requires fresh approval.

## Registration

The public `localProgramGrantSchema` defines the complete closed registration.
Start from the [local example](../../examples/controller-local-effects/README.md).
An entry binds:

- `id`, `adapter_id`, `kind: "local_program"`, implementation ID/digest and
  `host_driver_digest`; fixed `provider.executable`, `argv`, and `runtime` inventory.
- Canonical repository identity and allowed source/target refs; required evidence
  producer/schema pairs bound to `reviewed_head`.
- Exact named `operations`, each with `semantics: "write" | "observe"`, registered
  input/result schema documents and digests, and resource conflict keys.
- Explicit credential source IDs and allowed network origins, input/output byte
  limits (at most 1 MiB), and timeout (1–600 seconds).
- Closed envelope schema IDs/digests from `effectRequestSchemaDigest` and
  `effectResultSchemaDigest` for `local_program`.

Measure the installed host with `measureBuiltinEffectImplementations`, then use
`deriveLocalProgramHostDriverDigest`. Compute runtime and provider identities with
`localProgramRuntimeDigest` and `localProgramImplementationDigest`, and verify
actual protected files with `measureLocalProgramImplementation`. Production
remeasures the driver and provider, checks the current approval, and fences the
activation before invocation. Do not copy example placeholder hashes into approval.

The matching adapter registration uses `effect_id` and the local request envelope
as its output schema. Its request chooses only a registered operation, allowed
refs, immutable evidence and a schema-checked payload. It cannot select another
executable, arguments, environment, credentials, or additional authority.

## Private invocation protocol

The host sends one `localProgramInvocationSchema` JSON document on stdin after
persisting process identity. It includes execute/inspect mode, stable operation
identity, a fresh invocation ID, implementation/authority/request digests, the
request, repository scope, verified evidence bytes encoded as base64, and explicit
credentials. Credentials come from protected source files; they are never argv or
ambient environment variables. The child gets a private working directory and a
minimal environment. No ambient HOME, PATH, provider tokens or shell startup files
are inherited. Use absolute executable paths for any subprocesses.

Return one `localProgramOutcomeSchema` JSON document on stdout, repeating all
identity fields exactly. `applied` contains the registered typed result;
`not_applied` contains a typed observation and bounded diagnostic code;
`uncertain` reports that the authoritative outcome cannot be established. Results
must match repository, operation, refs and reviewed head. Stderr is not published.
The complete invocation, including credentials and encoded evidence, must fit
`max_input_bytes`. Evidence is aggregated sequentially under that limit.
Malformed, oversized, mismatched, credential-echoing or lost responses cannot
establish success. Provider code must never encode or intentionally disclose
credentials; literal echo detection is a final guard, not information-flow isolation.

Grant the effect actual access to every evidence reference. Generic result
consumers are intersected with the request and every evidence audience. Include
an intended result reader in those input audiences, or keep the result private.
Passing a reference through a controller does not authorize that controller to
read the referenced bytes. Keep private report bodies separate from narrowly
shareable approval evidence where appropriate.

## Bounded steps, observation and recovery

Publish/create-or-reuse-PR, observe CI, and merge are separate bounded invocations.
A successful CI observation with `pending` in its typed payload is **applied**:
the observation succeeded. Return promptly. The controller can continue independent
native work and issue `wait` with `wake_after_ms` from 1000 through 600000.
The delay is persisted with the decision timestamp; resume preserves the original
deadline. A later decision replaces that wait; keep the desired next-observation
time in controller state and return the remaining bounded delay when waiting
again after other work. Child/artifact events wake planning early. A due request carries
`wakeup: {kind: "timer", decision_id, due_at}`. Omit the delay for legacy indefinite
waits. Choose an operationally sensible observation interval, not rapid polling.
The example schema includes a `request_tag`: assign one stable tag per planned
observation and keep it unchanged during recovery. A later observation gets a new
tag; submitting the same completed logical request is rejected as a duplicate.

The broker persists intent and prepared identity before execution. Process
admission, spawned identity and cleanup settlement are also durable. Resource
keys serialize overlaps, including operations with different names; unrelated
native work uses its existing scheduler. Ambiguous effects block conflicting
resources until authoritative inspection resolves them.

On recovery, the host first proves the original program and descendants stopped
on the original host/namespaces, then starts a **read-only inspect** invocation.
Implement inspect without writes: locate the exact intended ref/PR/merge and
verify its postconditions. Return applied with the existing receipt, not_applied
only on authoritative absence, and uncertain otherwise. The host never blindly
replays execute after a crash, timeout, lost response or ambiguous journal append.
Unobservable cleanup remains blocked; restore authorized observation on the
original host, stop the original processes, inspect partial effects, and resume
reconciliation. Revoked/replaced approval remains fenced until explicitly resolved
by the operator. Starting another action is not a safe uncertainty bypass.

The example and tests use temporary Git repositories and a local fake forge.
They do not publish a real PR, merge a real branch, or call a model provider.
