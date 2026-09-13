# Issue #109: sanitize inherited sandbox descriptors

This repairs the existing descriptor-isolation contract in
[#106 §§5–6](issue-106-bubblewrap/spec.md). Ambient non-CLOEXEC descriptors can
survive Node's explicit six-entry spawn configuration and reach the native
capability probe. The probe must continue rejecting every unexpected descriptor.

The repair belongs in the child launch/bootstrap path shared by capability
probes and delegated commands. It must preserve standard I/O, temporary
authorization controls, process identity, and cleanup. It must never modify
live host descriptors or weaken runtime approval. Tests use fresh protected
fixtures and synthetic unused PTY handles; application campaigns are not needed.

Implementation boundary: both production runners use the same host-authored
bootstrap. Its fixed inner Bash program runs with `-c`, avoiding a script-input
descriptor while sanitizing descriptors before READY. Namespace PID 1 is owned
by Bubblewrap; its existing cleanup closes unrelated descriptors. The host's
descriptor table remains untouched. Standard I/O and release/READY descriptors
remain available until the existing release protocol closes its controls.

Compatibility: the bootstrap bytes are bound by each project's
`bootstrapSha256`. Previously materialized projects remain rejected by the
existing verification if their bootstrap differs; do not rewrite retained
evidence. Fresh runs use the new bootstrap. This changes neither the approved
runtime inventory nor the Bubblewrap/native-probe approval.

Source evidence: [libuv 1.52.1 child initialization](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/process.c#L318-L335)
does not close unrelated inherited descriptors when given explicit stdio.
[Bubblewrap 0.12.0 namespace-init setup](https://github.com/containers/bubblewrap/blob/v0.12.0/bubblewrap.c#L3217-L3235)
closes extra descriptors in PID 1 while passing them to the command child.
The installed Bash manual documents `-c` positional arguments and the
`{varname}>&-` descriptor-close form used by the fixed bootstrap.

- [x] Reproduce inherited-descriptor failure with the approved real runtime;
  retain clean and CLOEXEC controls and await four concurrent admissions.
- [x] Implement child-only descriptor sanitation and verify both probe and
  command paths, including descriptor numbers outside the reported pair.
- [x] Preserve release framing and cleanup; review interpreter-internal
  descriptors, namespace-init ownership, and artifact compatibility.
- [x] Report a bounded unexpected-inherited-descriptor diagnostic from a
  validated failed probe report without exposing contents.
- [x] Complete independent review, focused tests, and repository gates.
- [x] Rebuild and verify the linked CLI; record verification and commit locally.

Verification evidence (2026-09-13):

- The new real regression fails against `be91109`: concurrent admission fails
  and the production command exposes synthetic PTY descriptors 34, 35, and 255.
  Its clean and CLOEXEC controls complete before the inherited case fails.
- With the repair, the complete real sandbox suite passes 42 tests in 12 files.
  The regression runs clean, CLOEXEC, and inherited-PTY workers; each performs
  four concurrent production-adapter captures and checks retained reports for
  `extra_fds: 0` and settled namespace-init identities. Production commands
  verify closed control descriptors, only live standard-I/O descriptors, and
  confirmed cleanup. Parent descriptors remain present after the operations.
- Direct bootstrap tests establish that only descriptors 0–4 exist before
  READY, preserve quoted/newline/empty command arguments, and reject unavailable
  descriptor enumeration before executing a command.
- The diagnostic regression first failed on the generic exit message, then
  passed with a schema-validated count. Invalid or incomplete reports retain a
  generic rejection, and private report contents do not enter the message.
- Typecheck, build, lint, format checking, and the production dependency audit
  pass. `conduct` resolves to this checkout's rebuilt `dist/bin/conduct.js`.
- The ordinary suite passes all 2,726 tests across 253 files, including packed
  CLI/extension loading, supervision, and core-boundary checks. The compiled
  bootstrap exactly matches the verified source.
- Independent review covered sanitation, argv handling, release framing,
  process ownership, artifact compatibility, diagnostic privacy, and the real
  regression tests; all actionable findings were addressed.
