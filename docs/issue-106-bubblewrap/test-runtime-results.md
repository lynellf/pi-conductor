# Test runtime preparation, 2026-09-12

The operator authorized the bounded preparation proposal. The patched binary
was built and staged unprivileged; no system package, protected prefix, AppArmor
profile, or sysctl was changed. The next execution gate is still blocked.

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
- Upstream utility tests pass all 26 subtests. Five upstream suites skip;
  sandbox startup reports `bwrap: setting up uid map: Permission denied`.
  The seccomp suite additionally lacks its optional Python module. A zero
  upstream harness exit with these skips does not satisfy the execution gate.
- Kernel audit evidence shows AppArmor transition from `unconfined` to
  `unprivileged_userns`, followed by denial of the child `uid_map` write.
  No Bubblewrap process remained in the post-test process listing.

## Remaining operator boundary

Interactive sudo is required to install the staged binary in the protected
prefix. In addition, the host's AppArmor policy requires an explicit namespace
exception. The earlier preparation authorization excluded security-policy
changes, so neither action was attempted through a privilege workaround.

A separate manual installer has been prepared locally for review. It requires
an explicit `--approve-userns-profile` flag, validates the protected binary copy
against the digest above, refuses to replace an existing prefix/profile, and
adds this exact attachment only:

```text
abi <abi/4.0>,
profile pi-conductor-test-bwrap /opt/pi-conductor-test/bubblewrap-0.12.0/bin/bwrap flags=(unconfined) {
  userns,
}
```

The proposed parent directory is root-owned, private-primary-group accessible,
mode 0710; descendants are root-owned and not group/other writable. This limits
execution to that account's group, but permits arbitrary Bubblewrap arguments,
not only Conductor invocations. The profile is a namespace prerequisite,
not filesystem confinement. Descendants can inherit its allowance, so actual
`--disable-userns` and nested-namespace denial tests remain mandatory.

The profile passed an offline AppArmor parse with kernel loading and caches
disabled. The installer passed Bash syntax validation and independent review.
Neither was executed with privilege. Unloading a profile is not automatic
cleanup; any later removal requires settled processes and explicit review.

After operator installation, repeat upstream and production-policy probes
unprivileged at the final protected path. B4 and downstream feature delivery
remain unchecked until the real tests pass. An already authorized Linux test
host with suitable namespace policy remains an alternative.

References:

- [Verified upstream release](https://github.com/containers/bubblewrap/releases/tag/v0.12.0)
- [Ubuntu user-namespace restrictions and explicit profiles](https://documentation.ubuntu.com/release-notes/24.04/)
- [AppArmor profile syntax](https://manpages.ubuntu.com/manpages/noble/man5/apparmor.d.5.html)
