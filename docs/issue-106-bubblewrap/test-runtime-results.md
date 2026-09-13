# Test runtime preparation, 2026-09-12

The operator authorized the bounded preparation proposal and subsequently
installed the reviewed protected binary and explicit AppArmor profile. The
installed digest matches the reviewed build. Unprivileged real isolation tests
passed, including the trusted bootstrap proof. This file records the dated host
preparation evidence; current production behavior is documented in
[delegation](../delegation.md#bubblewrap-command-sandbox-issue-106).

## Completed evidence

- GitHub's API reports a valid, verified maintainer signature for annotated
  tag `v0.12.0`, object `014a04330642e5c870418beb621532cb896e0002`.
  The local fetched tag matches that object and resolves exactly to reviewed
  commit `2a76602a8c71f36c1527cf9fc3417d9149822e0c`.
- `sudo -n true` reports that a password is required. The apt simulation
  proposes seven additions, no upgrades/removals. Instead of system installation,
  six required build/library packages were downloaded and extracted into one
  private temporary directory; every archive hash matches local APT metadata.
- Build: GCC 13.3.0, Meson 1.3.2, Ninja 1.11.1, libcap 2.66, glibc 2.39.
  The proposal's feature flags were used, with an explicit library search path
  into the extracted development packages. ELF inspection shows no RPATH/RUNPATH;
  the resulting binary needs the installed `libcap.so.2` and `libc.so.6` only.
- Staged and build binary SHA-256 are equal:
  `1b8d973c466a97016298801d2ac4de656b5e141f492ade67ae99b4df5dfe542e`.
  This is a locally built artifact, not an upstream-signed binary.
- A separate four-file Bash runtime was copied without links. Installed
  Bash/libc/libtinfo/libcap package verification showed no discrepancies.
  Its inventory remains preparation evidence, not production runtime admission.
- Before the profile installation, upstream utility tests passed all 26 subtests. Five upstream suites skipped;
  sandbox startup reports `bwrap: setting up uid map: Permission denied`.
  The seccomp suite additionally lacks its optional Python module. A zero
  upstream harness exit with these skips does not satisfy the execution gate.
- Kernel audit evidence shows AppArmor transition from `unconfined` to
  `unprivileged_userns`, followed by denial of the child `uid_map` write.
  No Bubblewrap process remained in the post-test process listing.

## Completed operator installation

The operator completed the separately reviewed manual installation. Subsequent
unprivileged inspection verified the binary at
`/opt/pi-conductor-test/bubblewrap-0.12.0/bin/bwrap`, its SHA-256 above,
root ownership, regular-file type, non-setuid mode 0755, and protected ancestors.
The existing distribution package was not replaced.

The reviewed manual installer required
an explicit `--approve-userns-profile` flag, validates the protected binary copy
against the digest above, refuses to replace an existing prefix/profile, and
and installed this exact attachment:

```text
abi <abi/4.0>,
profile pi-conductor-test-bwrap /opt/pi-conductor-test/bubblewrap-0.12.0/bin/bwrap flags=(unconfined) {
  userns,
}
```

The installed parent directory is root-owned, private-primary-group accessible,
mode 0710; descendants are root-owned and not group/other writable. This limits
execution to that account's group, but permits arbitrary Bubblewrap arguments,
not only Conductor invocations. The profile is a namespace prerequisite,
not filesystem confinement. Descendants can inherit its allowance, so actual
`--disable-userns` and nested-namespace denial tests remain mandatory.

Before installation, the profile passed an offline AppArmor parse with kernel
loading and caches disabled. The installer passed Bash syntax validation and
independent review. Unloading a profile is not automatic
cleanup; any later removal requires settled processes and explicit review.

## Real isolation evidence

The dedicated `pnpm test:sandbox` gate fails when prerequisites are absent;
ordinary unit tests do not silently count unavailable sandbox tests as passing.
It requires explicit `PI_CONDUCTOR_BWRAP`, `PI_CONDUCTOR_BWRAP_SHA256`, and
`PI_CONDUCTOR_BWRAP_RUNTIME` values from the approved local preparation.

Two isolation tests pass against the installed binary and a fresh copy of the
four-file Bash runtime, with an independently compiled test-only C probe:

- All five capability sets are empty, `no_new_privs` is set, and no extra
  inherited descriptors reach the probe.
- The six character devices and fixed `/dev` entries have the expected types
  and targets. No non-loopback interface exists. A host listener, first reached
  successfully from the host, cannot be reached from the sandbox.
- Actual `unshare(CLONE_NEWUSER)` fails. The final namespace's visible
  `max_user_namespaces` is not the enforced ancestor limit: upstream sets the
  first namespace's limit to one and then enters a second namespace. Testing
  the syscall, rather than assuming the visible sysctl must equal one, is essential.
- Host sentinel/home/Git/sysfs paths are hidden. Runtime and projected base
  files reject writes; the private writable mount and private temporary/home/run
  mounts accept them. The host-side immutable input remains unchanged.

The complete dedicated suite passes 15 tests: two isolation tests, one actual
static observer test, and 12 bootstrap tests. The bootstrap tests bind startup
and final namespace-init identity, verify control-FD closure in executed C code,
reject malformed release frames and persistence failure, and exercise host death
before and after release with an owned background descendant. Process-state
checks distinguish dead/zombie, missing, or reused identities from failed
namespace observations. Correlated exit status and drained output are checked.

These results establish prerequisite and fixture evidence for that host. They
do not approve another host's binary, runtime, or capability probe; production
repeats exact admission checks against the operator-supplied approval.

The upstream sandbox suite was repeated at the installed path: 66 tests pass,
one skips for unavailable message queues, and one fails because its recursive
host-root mount inspection cannot stat an unrelated protected Docker network
namespace. The first attempt also hid its own helper under the test's private
`/tmp`; moving a copy of the upstream test scripts outside `/tmp` resolved that
harness error. The remaining upstream failure is recorded, not counted as green.
Conductor's fixed runtime mounts do not include host root or Docker state.

References:

- [Verified upstream release](https://github.com/containers/bubblewrap/releases/tag/v0.12.0)
- [Ubuntu user-namespace restrictions and explicit profiles](https://documentation.ubuntu.com/release-notes/24.04/)
- [AppArmor profile syntax](https://manpages.ubuntu.com/manpages/noble/man5/apparmor.d.5.html)
