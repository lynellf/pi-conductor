# Patched test runtime proposal

Status: prepared for operator authorization; no installation performed.

The current development package, `bubblewrap 0.9.0-1ubuntu0.1`, has no verified
fix for CVE-2026-87766. It cannot run the approved bootstrap/isolation proof.
The manifest and static prerequisite increments do not remove this gate.

## Proposed bounded host changes

1. Install the missing build prerequisites from the configured distribution
   repositories: `meson`, `ninja-build`, `pkg-config`, and `libcap-dev`, with
   `--no-install-recommends`. A C compiler is already available. Simulate and
   review the package transaction, including transitive dependencies, before
   execution; retain exact versions. Refresh package indexes only if needed;
   do not remove packages or upgrade beyond that reviewed transaction.
2. Fetch the upstream `v0.12.0` annotated tag and require it to resolve exactly
   to `2a76602a8c71f36c1527cf9fc3417d9149822e0c`. The proposed source trust basis
   is the official repository over HTTPS, the exact commit, and GitHub's
   verified maintainer-signature binding. Record the tag/signature verification
   evidence; do not describe a downloaded short key ID as an independently
   authenticated trust anchor. Missing or inconsistent verification stops
   preparation. Record compiler/dependency versions, build flags, and binary
   SHA-256. A version string alone is insufficient build provenance; the local
   compiled binary itself is not upstream-signed.
3. Build unprivileged using Meson/Ninja with a separate install prefix
   `/opt/pi-conductor-test/bubblewrap-0.12.0`, using `-Dman=disabled`,
   `-Dselinux=disabled`, `-Dbash_completion=disabled`,
   `-Dzsh_completion=disabled`, and `-Dtests=true`, without an `assume_kernel`
   override. Run upstream tests, stage unprivileged, then use privilege only
   to install the inventoried binary/provenance files in that prefix. Never
   run a mutable build system as root. Verify the final SHA-256 matches staging;
   require root-owned non-writable ancestors, binary mode 0755, no setid bits,
   and no file capabilities. Install via a sibling staging prefix and rename
   after verification so a failed copy does not become a trusted install.
4. Prepare a separate link-free, Bash-only test runtime containing approved
   package bytes for Bash, its ELF interpreter, and transitive libraries.
   Use locale `C`, canonical directories and copied regular-file bytes; do not
   execute `ldd` on untrusted inputs. Project/Node/pnpm runtimes come later.
   Record and explicitly approve its inventory outside the project manifest.
5. Run the inert namespace prerequisite probe first, followed by the exact
   bootstrap release/FD/identity tests. If the host denies required namespaces
   or observations, retain the failure and stop. This proposal does not
   authorize changing AppArmor, sysctls, namespace policy, or other security
   settings.

The system `/usr/bin/bwrap` package stays installed; Conductor's test launcher
will use the separate absolute path without changing ambient PATH. No production application campaign or
automatic sandbox enablement is part of this preparation. Downstream feature
implementation proceeds only once the approved real bootstrap gate passes.
Keep downloads/builds in one recorded temporary directory. Test-created
processes and temporary materializations must settle; unconfirmed cleanup
stops testing and preserves evidence. The test binary/provenance remains
inspectable until explicit removal.

An operator-provided Linux test host with equivalent verified prerequisites
can satisfy the gate instead of the proposed local preparation.

## Sources and remaining verification

- [Upstream signed release](https://github.com/containers/bubblewrap/releases/tag/v0.12.0)
- [Build requirements](https://github.com/containers/bubblewrap/blob/v0.12.0/meson.build)
- [Security advisory](https://github.com/containers/bubblewrap/security/advisories/GHSA-pxhw-h44j-8pfx)

No signed source checkout, build, runtime inventory approval, or real sandbox
test has been performed by this proposal. Missing signing-key verification,
package provenance, or privilege to install the protected prefix is a blocker,
not a reason to relax the prerequisite contract.
