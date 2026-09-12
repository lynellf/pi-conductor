# Issue #106: delegated command execution through Bubblewrap

Status: Acknowledged by the overseer on 2026-09-12; implementation in progress.

## 1. Objective and authority

An explicitly authorized delegated child can edit its projected project, run
arbitrary foreground build/test/inspection commands, inspect diagnostics, and
repair its work in the same session. Existing profiles remain file-only.
Commands acquire no acceptance, commit, integration, or publication authority.
The parent remains the only FSM actor and owns integration.

This extends [delegation](../issue-17-delegation-lite/spec.md) and
[execution controls #76/#77](../open-issues-september/spec.md). It preserves
#26/#37's removal of unrestricted child execution and shared Git authority.
Workspace selection and command isolation remain different contracts; the
unavailable `workspace.backend: container` option is not enabled or repurposed.

Approved assumptions:

- Initial platform is Linux with a verified patched, non-setuid Bubblewrap.
- Initial command networking is always disabled. Broader networking and
  aggregate CPU/memory/process quotas are rejected as unsupported.
- Callers prepare a complete, non-secret runtime tree. Conductor does not
  discover/install missing dependencies or mount broader host paths to help.
- Commands and file tools use the same child-private execution materialization.
  The generated Git worktree remains host-owned for validated patch collection.
- Full output is privately retained outside the sandbox and retrieved through
  a child-scoped tool, rather than exposing conductor's storage directory.

## 2. Proposed profile configuration

This syntax is parsed by the current development build. Command dispatch remains
disabled with `sandbox-backend-unavailable` until the real execution gates pass:

```yaml
subagents:
  - name: implementer
    models: [openai-codex:gpt-5.6-luna]
    max_session_cost_usd: 2
    system_prompt: .pi/roles/implementer.md
    workspace:
      projection:
        required: false
        allowed_paths: [src, tests, package.json]
        default_paths: [src, tests, package.json]
    execution:
      backend: bubblewrap
      runtime_root: .pi/prepared-runtime
      writable_paths: [src, tests]
      network: none
      environment:
        PATH: /usr/bin:/bin
        LANG: C.UTF-8
      max_output_bytes: 67108864
    tool_execution:
      timeout_seconds: 300
      termination_grace_seconds: 2
      max_recoverable_timeouts: 2
```

`execution` is separate from the existing deadline-only `tool_execution`.
Omission resolves to `file_only`, adding no tools or runtime prerequisites.
The initial explicit backend is only `bubblewrap`; unknown fields/backends and
unsupported guarantees fail before dispatch. No arbitrary bwrap arguments,
mount destinations, host environment interpolation, or task-supplied policy.

`runtime_root` names an owner-prepared filesystem tree, resolved relative to
its manifest directory. Copy it without following links or preserving hardlinks
into an immutable runtime snapshot; accept directories and regular files only.
Create a trusted empty sandbox root and fixed destinations, then read-only bind
the snapshot's admitted top-level entries at their canonical sandbox paths.
The initial closed set is `bin`, `sbin`, `usr`, `lib`, `lib64`, `etc`, and `opt`;
reject other top-level entries. Never bind the runtime tree or host `/` as root.
`/bin/bash`, absolute ELF interpreters, libraries, and transitive dependencies
must exist entirely within those inputs. Workspace, procfs, devices, temporary,
home, run, and control paths are fixed host-created mounts, never runtime data.

The source must not be host root/home, the primary checkout, agent/conductor
state, or another child's workspace. It contains no credentials, host sockets,
or shared Git objects. The runtime/manifest author is a trusted operator;
project files and command processes are untrusted. Bootstrap interpreter and
loader/library digests require host-approved provenance separately from project
dependencies: pinning arbitrary caller bytes does not make them trusted.
A replaced/unapproved bootstrap runtime fails admission. This trust verification
is part of prerequisite implementation and its tampering tests, not a claim
that a content hash alone establishes provenance.

`writable_paths` is an explicit list of normalized repository-relative literal
paths within the resolved child projection. Files authorize editing that file;
directories authorize creating, editing, and deleting descendants within them.
Other projected content is read-only. Duplicate, overlapping, traversal,
reserved-control, or out-of-projection capabilities are rejected. New files
must be within a writable directory; no arbitrary writable host bind exists.
Resolve this list against the exact admitted task projection after parent sparse
inheritance, using one shared authority predicate for mounts, file tools, and
ingestion. A writable directory authorizes every projected descendant; it cannot contain
an intended read-only/control exclusion. Reserve `.git` components at any depth
and fixed runtime/control/output destinations. These restrictions apply equally
to file tools and executed programs.

`environment` accepts only `PATH`, `LANG`, `LC_ALL`, and `TERM`, with NUL-free
literal strings up to 1,024 bytes each. Reject all other names. PATH components
must be absolute paths within admitted read-only runtime mounts, with no empty
or relative components. HOME=`/home/sandbox`, TMPDIR=`/tmp`, and working
directory `/workspace` are fixed. Start with `--clearenv` and no ambient host
inheritance or interpolation. These explicit non-secret values are pinned;
the trusted manifest author must not put secrets in them. Adding a supported
environment key is a schema/security-contract change. Network accepts only
`none` in this version.

`max_output_bytes` is a positive safe integer, at most 64 MiB per command across
both streams, default 64 MiB. This is an output-retention limit, not a memory,
CPU, process, or filesystem quota.

## 3. Admission and durable pinning

Validate the entire delegation request before queueing. Resolve/freeze the
effective policy, selected projection, writable authority, prepared runtime,
backend prerequisite evidence, and canonical policy digest. Include this
identity in the accepted submission fingerprint and durable queued-task
record, then repeat it in the child-start record. A duplicate submission with
changed authority is rejected. Resume never substitutes the current manifest
or a newly chosen runtime for the accepted policy.

Pin defaults through the existing manifest snapshot path. Ensure the fresh
host consumes those pinned values rather than independently resolving omitted
defaults. Existing records without sandbox policy retain file-only semantics.
Malformed or inconsistent new records fail closed; no legacy shell fallback.

`delegation_submission_accepted` and `subagent_started` retain backend,
`execution_policy_digest`, `runtime_digest`, and private materialization identity.
The pinned runtime descriptor includes preparation schema version, canonical
source path/identity, and a SHA-256 inventory digest over sorted normalized
paths, file types, executable modes, and regular-file content digests. Use the
existing canonical hashing conventions. Copy to a host-owned immutable runtime
snapshot and validate its digest before each child start and on resume; changes
or missing snapshot fail instead of silently rereading changed source input.
Fresh `hostFactory` must receive the same pinned LoadedManifest that is persisted;
passing the original unpinned `loaded` object does not satisfy this contract.

The exact profile parser follows current YAML parsing conventions. Transport
and persisted contracts use one TypeBox schema per shape with strict unknown
field rejection. Nothing about sandbox implementation enters the pure FSM.

## 4. Filesystem boundary

Materialize only authorized project files into a fresh private execution tree,
with an immutable base and private writable copies at the declared paths.
Source project bytes from the already admitted generated child worktree and
exact projection; exclude `.git` and Git control paths before copying. Do not
materialize by querying the primary checkout or shared Git objects.
Never hardlink files from the primary checkout, other children, or runtime.
Read-only sources cannot be replaced by renaming a writable ancestor.
The retained materialization is the only writable backing store; it is not the
Git worktree and has no bind source shared with another child. Host-prepared
mountpoints and their ancestors cannot be renamed by commands. Keep this tree
between command calls, including after ordinary command failure.

The sandbox starts from a trusted empty root. Create mount destinations before
attaching untrusted content. Mount the prepared runtime read-only and project
content at `/workspace`; attach only declared private writable subtrees/files.
Use private temporary/home/run directories and minimal devices plus namespace
procfs. Do not bind host `/`, HOME, `/run`, `/tmp`, credential/config directories,
conductor storage, sibling workspaces, IPC sockets, or primary Git metadata.
No `.git` control file, shared object store, alternates, hooks, or host config is
available inside the sandbox. Git inside commands is unsupported initially.

Symlinks and transitive dependencies must be handled deliberately during caller
preparation and trusted materialization. Never resolve a link into undeclared
host input. Initial materializations accept regular files/directories only;
callers must prepare self-contained copies of linked dependencies. Reject
special files and multiply linked regular files on initial capture, before any
host file-tool access, and on every ingestion. Even links wholly inside the
private tree are conservatively unsupported; never preserve hardlinks in copies. A command may create links
inside its isolated writable area, but host tools and patch ingestion never
follow them. Such entries are reported as unsupported output for inspection,
not copied into the integration worktree or silently dropped.

Serialize Bash, file tools, materialization, and ingestion for each child.
Key the gate by child execution owner and hold it through confirmed descendant
cleanup, spool finalization, and durable terminal persistence; another child has
its own gate. Host reads/copies use no-follow, identity-checked,
root-anchored traversal and never open devices, FIFOs, sockets, or magic links.
A realpath check followed by an independent pathname-based SDK operation is not
sufficient. Sandbox-mode file tools must either use the same OS confinement or
a descriptor-anchored no-follow adapter; do not expose existing host file tools
until that boundary is verified. The operation gate spans validation and actual
access, so no untrusted command can mutate paths concurrently.

Bound ingestion to 10,000 entries and 256 MiB per captured delta. First capture
and validate the complete delta in private staging. Unsafe/unsupported entries,
identity changes, or exceeded bounds apply none of that delta to the Git
worktree. If interruption occurs during the later application, durably report
`integration_incomplete`, seal automatic integration, and retain staging plus
both trees for explicit parent recovery. Do not promise atomic multi-file
application or silently discard unsafe entries.

Only validated regular-file changes/deletions within writable authority enter
the generated host-owned worktree. Host Git runs with its captured Git identity,
an absolute trusted executable, explicit captured GIT_DIR/GIT_INDEX_FILE/
GIT_WORK_TREE, and a constructed environment rather than `process.env`.
Disable system/global config, prompting, optional locks, hooks, fsmonitor,
external diff/textconv, filters, and submodule recursion for the invoked
commands. Verify Git control identities remain host-owned before use. Parent integration and existing child
result verification still apply; command exit 0 is not acceptance evidence.

## 5. Command isolation and prerequisites

Use direct argv construction for Bubblewrap, then the trusted bootstrap and
`/bin/bash --noprofile --norc -c <command>`. Command text is data at the wrapper
boundary; it is interpreted only by the authorized shell inside the sandbox.

Require fresh user, PID, mount, network, IPC, and UTS namespaces, disabled nested
user namespaces, no capabilities, a new session, and a clean environment.
Operationally use `--unshare-user --disable-userns` and verify that user code
cannot create another user namespace; this does not require disabling user
namespaces globally on the host.
Use strict flags, not best-effort `*-try` options. `--die-with-parent` supports
host-death cleanup but is not sufficient proof by itself. No provider/model
communication runs inside the command sandbox.

Spawn with explicit stdin/stdout/stderr and only the bounded setup/status
control descriptors. No inherited provider, log, socket, or session descriptors.
All control descriptors close before user code executes. Verify this through
executed `/proc/self/fd` inspection in integration tests.

Before admitting work, verify Linux, executable identity, non-setuid mode,
patch provenance, required option support, and an inert production-policy
namespace/mount probe. Accept an upstream release containing the 0.12.0 fix or
an exact distribution build with authoritative, locally verified backport
provenance. An unchecked version override or caller assertion is not proof.
Use an absolute trusted Bubblewrap path: a root-owned regular executable with
no setuid/setgid bits or file capabilities, through non-user-writable ancestor
directories, run by an unprivileged observer. Check device/inode/mode/provenance
immediately before spawn and fail on change; document any privileged package
replacement race not closed by descriptor execution. Never resolve it from
ambient PATH. Use only the admitted immutable runtime snapshot.

The probe must verify final namespace differences, admitted mounts, denied
sentinel paths, expected FD/device sets, empty capabilities, denied nested user
namespace creation, disconnected networking, and descendant settlement. A
version/help command or permissive sysctl is not a substitute.

Do not execute the capability probe with an unverified vulnerable build.
Do not install software or alter host security settings automatically.
Missing runtime inputs and disabled namespaces produce actionable prerequisite
errors, not extra mounts, degraded isolation, or host Bash.

Bubblewrap shares the host kernel. This feature does not protect against
kernel vulnerabilities or provide VM isolation or aggregate resource quotas.
Commands can still exhaust host CPU, memory, process IDs, or backing storage;
deadlines/concurrency do not prevent those denial-of-service effects.
Namespace procfs and minimal devices expose shared-kernel interfaces; no host
procfs/sysfs/debugfs or additional host devices are mounted. Enumerate the
intended device set in real tests. Existing concurrency/deadline controls remain enforced. Network is disconnected;
no host service sockets, proxies, DNS config, or network-enabling fallback.

## 6. Execution lifecycle and restart

Use the existing ToolExecutionController for deadlines, timeout budgets,
execution IDs, cancellation, and start/terminal ordering. Add a generic host
execution adapter; delegated children are its first required consumer. Do not
reuse the global host environment-marker scan as sandbox lifecycle proof.

The controller durably records start before setup. Setup creates a private
output spool and starts only trusted bootstrap code behind an authorization
gate. A new correlated `tool_execution_sandbox_ready` record binds the execution
to the policy, launcher identity, independently verified sandbox PID-namespace
init identity, boot/origin, namespace identities, and output reference. Append
and validate that record before releasing the user command.

The gate must require a complete explicit release message. EOF, malformed input,
persistence failure, or host death must terminate without executing user code.
**Do not use Bubblewrap `--block-fd` alone as this authorization gate:** in
v0.12.0 its read result is ignored, so closing the pipe releases the wait.
Use a fixed host-authored bootstrap interpreted by the approved immutable
Bash/runtime. The user command is an argv value, never interpolated into the
bootstrap source. Use release-read FD 3, ready-write FD 4, and Bubblewrap's
JSON-status FD 5 alongside intended stdio only. The bootstrap emits a fixed
READY frame on FD 4, waits for a complete exact release frame on FD 3, rejects
EOF/short/malformed/error reads, closes FDs 3 and 4, then execs the user shell.
Bubblewrap must close its status FD before reaching the bootstrap. READY is a
framing marker, not a nonce or independent authentication proof; bootstrap
trust and FD ownership establish the pre-command boundary.

Startup JSON identifies the host-visible PID of namespace PID 1 for the
supported invocation without `--pidns` or `--as-pid-1`. It occurs before mount
setup and can contain an earlier user-namespace identity. Record early PID1
PID/start/PID-namespace mapping, then wait for bootstrap READY. Re-read that
same PID/start with NSpid ending in 1 and the same PID namespace. Record final
mount/user/network/IPC/UTS observations separately and validate required
isolation; do not require the early and final user namespace inodes to match
when `--disable-userns` creates a second namespace. Append `sandbox_ready`
after final verification, then send release. On failure close the release pipe
and terminate only matched owned identities; the bootstrap must exit on EOF.

The first implementation spike must prove this exact gate and FD/init mapping
with the supported Bubblewrap/Node build, including partial frames, EOF,
persistence failure, host death before release, modified bootstrap interpreter,
and absence of control FDs in user code. This is an enablement gate, not an
assumption to be filled in after exposing the command tool. Setup status alone must not be mislabeled as final namespace or
command readiness. No `--as-pid-1` user command or caller-provided namespace FDs.

A normal terminal result uses the live Bubblewrap monitor's correlated exit
status plus status/output settlement and the recorded namespace-init identity.
It requires verified command status, drained output,
namespace-descendant settlement, and durable terminal persistence. An observed
launcher exit alone is insufficient. Signal only currently verified owned
identities; use held pidfds where available and verify PID/start/origin before
any fallback. Timeout/cancellation escalate within the existing grace policy,
then report confirmed or unconfirmed cleanup honestly. Do not mark cleanup confirmed or admit a following child operation until the
required evidence establishes descendant settlement.

Child cancellation propagates through the tool signal and awaits every owned
execution before disposal. Global abort awaits all children. An unresolved
execution seals the affected child's operation gate; it never signals siblings
or silently bypasses any existing run-level cleanup barrier.

Restart never replays a command. Start without usable ready evidence remains
unknown. Ready without a terminal record is reconciled on the original host
using verified origin and sandbox identity; unrelated inaccessible host
processes are not a reason to reject an otherwise proven namespace lifecycle.
If exact init/namespace lifetime cannot be established, preserve unconfirmed
cleanup and partial files/output. A vanished launcher is not proof. Any future
automatic namespace-death proof requires an executable test of the exact kernel
and identity assumptions; it cannot be added by inference during implementation.

## 7. Results and output

The opted-in child gets `bash` and `read_execution_output` in addition to its
existing confined file tools and pinned completion tool, if any.
`bash` returns an accurate command exit code/signal, bounded stdout/stderr
previews, truncation flags, execution identity, and opaque output references.
A nonzero command exit with confirmed cleanup is an ordinary tool result for
local repair; it does not automatically fail the role or select another model.
Distinguish setup failure, command exit/signal, timeout, cancellation,
unconfirmed cleanup, and incomplete output capture in durable metadata.

Spool streams outside all sandbox mounts with private permissions. Durable
records contain references, counts, digests, category, and cleanup disposition;
no command arguments, environment values, or raw output are added to lifecycle
records. The declared non-secret effective policy is retained separately.
Output is untrusted data, never instructions to the host.

`read_execution_output({output_ref, stream, offset, max_bytes})` accepts no path.
Resolve references only through persisted run/child/execution metadata and
a private host-owned run-state spool root. Create the spool before launcher
spawn, publish byte counts/digests only after safe persistence, and retain
referenced files through normal command/child cleanup and restart. Deletion
requires the existing explicit run-retention/inspection policy.
Authorize each reference against the current child and execution; enforce a
bounded chunk (maximum 64 KiB). Other children cannot read it. Resume preserves
these references for operator inspection under existing run ownership.

Normal preview truncation retains complete output through the durable limit.
If the admitted cap or disk write fails, mark capture incomplete and stop the
command through the owned cancellation path while draining pipes for cleanup.
Retain captured bytes and accurate counts; never report complete capture or
successful observation after silent truncation. Do not replay to recover output.

## 8. Implementation layout, conventions, and verification

Use small host modules under `src/host/execution/sandbox/` for prerequisite
checks, policy materialization, bootstrap/supervision, and output storage.
Manifest policy belongs under `src/manifest`; durable TypeBox records under
`src/persistence`; delegated wiring under `src/host/delegation`. Preserve strict
TypeScript, named exports, no `any`, and the core's no-I/O/no-Pi boundary.

Example contract style (illustrative, not a new public API promise):

```ts
/** Return command status only after its owned sandbox has settled (#106 §6). */
export async function runSandboxCommand(
  request: Readonly<SandboxCommandRequest>,
): Promise<SandboxCommandResult> {
  return request.backend.execute(request);
}
```

Commands: `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`,
`pnpm format:check`, `pnpm audit --prod`.
Focused new tests use `pnpm exec vitest run tests/host/bubblewrap-*.test.ts` and
`pnpm exec vitest run tests/manifest/sandbox-policy.test.ts` (planned paths).

Always validate authority and preserve uncertain evidence. Ask before changing
this contract, installing prerequisites, or changing host security settings.
Never grant host Bash, add hidden mounts, replay ambiguous work, modify the
primary repository from the child, or claim unverified cleanup/security.

## 9. Acceptance and delivery gates

- [x] Default profiles are file-only; malformed/unsupported settings fail before dispatch.
- [ ] Policy and runtime authority are pinned before queueing and verified across restart;
      altered source/snapshot/manifest inputs cannot substitute for pinned authority.
- [ ] A child completes edit → failing test → diagnostics → repair → passing test
      and returns an inspectable patch in one session, without parent remediation.
- [ ] Two children do this concurrently with independent workspaces/output/gates.
- [ ] Executed programs cannot read denied host/credential/sibling/Git paths,
      escape via links, write read-only inputs, use host FDs/IPC, or reach a network.
- [ ] Declared prepared runtime inputs work; missing inputs fail without expansion.
- [ ] Timeout, child/global abort, host death, and restart exercise descendants,
      preserve partial effects, prevent replay, and do not cancel siblings.
- [ ] Complete and truncated output, retention failure, and cross-child reference
      denial are durably observable and locally inspectable, including after restart.
- [ ] Real tests run against a verified patched Bubblewrap. A skipped/unavailable
      integration environment does not satisfy the feature delivery gate.
- [ ] Documentation describes supported guarantees, prerequisites, and limits.

## 10. Current prerequisite evidence and approval

At the initial inspection on 2026-09-12, the development host had non-setuid
`bubblewrap 0.9.0-1ubuntu0.1`. Its changelog contains a different older CVE
backport, not proof for CVE-2026-87766. Canonical lists Noble as
“Needs evaluation”. This build does not pass the proposed prerequisite gate.
At that point no Bubblewrap sandbox had been executed and no host setting or package had been changed.
Implementation/unit work can proceed after spec acknowledgement; real sandbox
acceptance additionally requires a verified patched build and passing namespace
probe on an authorized test host. That prerequisite is not silently waived.

The operator has since installed the separately reviewed upstream 0.12.0 build
and its explicit namespace profile. Its installed identity is verified and the
restricted isolation and bootstrap fixtures pass. Production admission and
delegated execution remain in progress; see [test runtime results](test-runtime-results.md).

Sources:

- [Bubblewrap caller-owned security policy](https://github.com/containers/bubblewrap/security/policy)
- [Bubblewrap usage and namespace model](https://github.com/containers/bubblewrap)
- [Pinned 0.12.0 source and control-FD ordering](https://github.com/containers/bubblewrap/blob/v0.12.0/bubblewrap.c)
- [CVE-2026-87766 advisory](https://github.com/containers/bubblewrap/security/advisories/GHSA-pxhw-h44j-8pfx)
- [Ubuntu package status](https://ubuntu.com/security/CVE-2026-87766)
