# Issue #108: initialize protected sandbox workspace roots

This repairs the production admission ordering required by
[#106](issue-106-bubblewrap/spec.md). A fresh run declares `worktrees/` and
`sandbox/` as protected destinations before either directory exists. Runtime
capture then rejects their missing canonical paths before accepting children.

The production host must establish its fixed owned workspace roots before
sandbox capture. Existing unsafe roots are rejected, not repaired or omitted.
File-only submissions retain their existing behavior, including when the host
has sandbox approval configured. Runtime capture continues to require existing
canonical protected directories.

- [x] Reproduce fresh-layout initialization failure and implement secure,
  concurrent, idempotent creation under the protected run directory.
- [x] Verify unsafe existing roots, links, permissions, and redirected paths
  fail closed; preserve file-only behavior.
- [x] Report a bounded escaped path and distinguish missing, noncanonical,
  non-directory, symlink, and filesystem observation errors.
- [x] Exercise the real production host and admission adapter with a fresh run
  directory and one nonblocking four-task batch; verify durable acceptance.
- [x] Review the security boundary and pass focused and complete verification.
- [x] Rebuild and verify the linked checkout for testing.

Verification uses protected temporary repositories, the explicitly approved
local Bubblewrap runtime, and credential-free model stubs. Application campaigns
are not restarted by this repair.

Verification evidence (2026-09-13):

- Disabling only layout initialization through a temporary test transform makes
  the new production-host regression fail with the missing `worktrees` path and
  `ENOENT`. With initialization enabled, four children are durably accepted,
  started, and completed while their parent files remain unchanged.
- All 39 real Bubblewrap tests pass across 11 files, including rejection of a
  pre-existing workspace symlink without effects in its target directory.
- The ordinary suite passes all 2,718 tests across 253 files, including the
  package, CLI, process-supervision, and core-boundary checks.
- Directory identity checks reject root replacement while allowing a sibling
  child to change directory contents during concurrent admission.
- Typecheck, build, lint, format checking, and the production dependency audit
  pass. The linked `conduct` resolves to this checkout's rebuilt CLI; a compiled
  layout smoke check creates both roots at mode 0700 under four concurrent calls.

Separate verification follow-up: one sandbox-suite attempt timed out in the
existing changed-interpreter bootstrap test; the complete rerun passed. Review
identified that its test-only `launchBootstrap` harness awaits process identity
before attaching READY/status stream listeners, allowing early pipe closure to
be missed. Attach those observers before the first await in a separate harness
repair; this issue does not modify bootstrap behavior.
