# Real Bubblewrap fixtures

Run `pnpm test:sandbox` explicitly on an authorized Linux host as an unprivileged
user. Missing prerequisites fail this gate; the ordinary unit suite does not
include `*.real.ts` files. Passing the unit suite does not establish isolation.

Supply these values from an independently reviewed operator preparation:

- `PI_CONDUCTOR_BWRAP`: absolute protected path to the approved patched binary.
- `PI_CONDUCTOR_BWRAP_SHA256`: its previously approved SHA-256.
- `PI_CONDUCTOR_BWRAP_RUNTIME`: directory containing the approved Bash runtime.

The environment selects test inputs; it is not a production approval mechanism.
Do not generate an approval by hashing an arbitrary downloaded binary or runtime.
The current fixture consumes the preparation's adjacent
`bash-runtime-inventory.json`, an array with `path` and `sha256` fields, for these
regular, link-free runtime files:

```text
bin/bash
lib/x86_64-linux-gnu/libtinfo.so.6
lib/x86_64-linux-gnu/libc.so.6
lib64/ld-linux-x86-64.so.2
```

Tests copy the inventory into private temporary trees. `/usr/bin/cc` and
`/usr/bin/readelf` compile and inspect the repository's small test probes; their
only dynamic dependency is libc from the approved runtime. They are test code,
not additional production tools or runtime admission evidence.

`probe.c` observes descriptors before opening other files, checks capabilities,
devices and networking, and actually attempts a nested user namespace. Its
visible namespace-limit value is diagnostic: the effective limit can belong to
an ancestor namespace. The host verifies its listener is reachable before
asserting that the sandbox cannot connect. `fd-probe.c` isolates descriptor
inspection for the bootstrap release test.

See [the approved contract](../../../docs/issue-106-bubblewrap/spec.md) and
[recorded host preparation](../../../docs/issue-106-bubblewrap/test-runtime-results.md)
for provenance, required guarantees, and remaining implementation gates.
