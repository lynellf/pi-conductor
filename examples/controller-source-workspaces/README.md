# Source workspace production-host check

This directory contains a no-model verification harness for source workspaces.
`run.mjs` invokes the checked-in production-host tests through the repository's
test runner. It does not implement a second Bubblewrap launcher, and it does
not contact a model, network service, publication endpoint, or paid workflow.

The test creates a temporary local Git repository and runs the real host path
with an approved runtime. The fixed validator in that runtime reads the large
source file, writes a small scratch file, executes the prepared patch, and
emits bounded JSON on success. The scenario checks these concrete cases:

- the source tree contains more than 1 MiB of data;
- each generated patch is larger than 32 KiB while remaining within the grant;
- a prepared patch whose validator exits 7 is retained with normalized status 7;
- a repair prepared from the same base has a different source identity and exits 0;
- an 8 KiB scratch write exceeds the 4096-byte kernel quota and exits 23;
- the host envelope records source identity, capture completion, and confirmed cleanup;
- the original repository remains at its base commit with a clean working tree.

A second scenario submits two workers through controller-native admission.
Both run real sandbox commands against the exact prepared source, produce
separate outputs, and use independent Git repositories. Their durable
acceptance and start records retain the same source identity; the prepared
source and primary checkout remain unchanged.

The test is the executable example. Repository-side configuration and the
source grant fields are documented in
[`docs/issue-118-source-workspaces/README.md`](../../docs/issue-118-source-workspaces/README.md).
Runtime and source-repository approval are supplied by the operator and are
rechecked by the production host.

Run it from the repository root with the approved Bubblewrap executable,
runtime directory, and executable SHA-256 for the environment:

```sh
pnpm build
export PI_CONDUCTOR_BWRAP=/path/to/approved/bwrap
export PI_CONDUCTOR_BWRAP_RUNTIME=/path/to/approved/bash-runtime
export PI_CONDUCTOR_BWRAP_SHA256='approved-bwrap-sha256'
node examples/controller-source-workspaces/run.mjs
```

The command must run as an unprivileged Linux user with user and network
namespaces available to Bubblewrap. It leaves no repository changes; all test
state is temporary and cleaned up by the fixture.
