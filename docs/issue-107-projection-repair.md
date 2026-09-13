# Issue #107: sandbox selectable parent paths

This repairs the existing #52/#55 exact-path contract at the
[#106 sandbox admission boundary](issue-106-bubblewrap/spec.md), without adding
filename syntax or changing child authority.

Trusted parent capture returned every materialized Git filename as selectable
authority. The projection validator correctly rejected names containing spaces
or `+`, which made unrelated files reject an entire delegation batch.

The repair keeps two sets distinct: `paths` contains only selectable materialized
exact paths; `trackedPaths` retains every tracked filename, including sparse
omissions and names that cannot be selected. Every materialized entry still passes
raw-content and type checks before filtering; repository-permission checks remain
in force.
Writable-directory checks continue to use the complete tracked inventory.

Implementation and verification:

- [x] Reproduce the capture bug, then align sandbox capture with file-only selection.
- [x] Verify complete metadata and unchanged dirty/type/permission rejection.
- [x] Exercise real parent capture through atomic multi-task batch admission,
  unsafe explicit selection, and excluded-descendant writable rejection.
- [x] Make an invalid authority diagnostic identify its first offending filename
  with an escaped, bounded preview and explain the selectable/tracked distinction.
- [x] Execute safe delegated sandbox tasks on a protected fixture with unrelated
  non-selectable tracked filenames, using the approved local runtime.
- [x] Review the diff; pass ordinary and real sandbox tests, typecheck, build,
  lint, format checks, and production dependency audit.
- [x] Verify the linked CLI resolves to the rebuilt checkout.

Verification uses isolated test repositories and credential-free stub providers.
The failed application campaign is not restarted.

Verified on 2026-09-13:

- Ordinary suite: 251 files, 2,700 tests passed.
- Approved real Bubblewrap gate: 10 files, 37 tests passed, with no skips.
- Typecheck, build, lint, format checks, and production audit passed.
- The built capture reproduced the rejection before rebuilding and accepted the
  same protected-fixture scenario afterward, retaining all three tracked paths.
- The linked `conduct` executable resolves to this checkout's `dist/bin/conduct.js`.
