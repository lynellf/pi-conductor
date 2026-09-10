# Issue #103: durable process admission evidence

Implements issue #103 under the approved September execution controls §76 and
FSM §11–12. The original grep timeout and historical log-display changes are
outside this repair.

## Decision and safety contract

Persist an optional versioned admission object in the execution start record,
before invoking the executable tool. It contains a conservative boot-relative
start-tick boundary taken from the maximum start tick in a completed pre-launch
process snapshot, plus boot ID, PID namespace, namespace-init start identity,
observer time namespace, and network namespace. Boot ID binds the host boot;
the procfs view must match the observer's PID namespace. No environment,
arguments, process names, or wall-clock conversions enter this evidence.

Recovery validates the shape and current origin before using the boundary.
Only after an environment permission denial may it exclude a freshly stable
candidate whose own start ticks are strictly older than the boundary. An old
session leader alone is insufficient durable evidence. Marker-positive
ownership takes precedence. Equal/newer ticks and unproven sessions remain
unresolved. Live cleanup retains its existing exact snapshot checks.

Legacy logs get no manufactured baseline. Invalid evidence or mismatched boot,
PID view, time namespace, or network namespace rejects recovery with repair
guidance. Inspection never appends confirmation; explicit confirmation still
attests all original processes (including unmarked descendants) and inspected
partial effects. No privilege changes or signals against user processes.

## Ordered implementation and verification

- [x] Add validated additive persistence evidence and capture it before tool
  operations; test durable ordering, capture/persistence failure, and legacy shape.
- [x] Reuse validated evidence in reconciliation and permission exclusions;
  test older/equal/newer ticks, positive markers, PID/session races, corrupt
  evidence, origin mismatch, and unchanged logs on failure.
- [x] Exercise capture and recovery in separate processes with an inaccessible
  same-UID pre-existing process and a newly created inaccessible descendant;
  preserve the unmarked-descendant/operator-confirmation boundary.
- [x] Review, run focused and full tests, typecheck, build, lint/format and audit.
- [x] Update recovery documentation, rebuild, verify the linked executable and
  Pi package paths, and commit the tested changes.

## Limits

A missing historical baseline cannot be reconstructed from wall-clock log
timestamps, diagnostic candidate ticks, or a new recovery-time snapshot.
Strict tick comparison deliberately leaves equality uncertain. This is process
supervision within the existing trust model, not a sandbox against privileged
namespace or kernel manipulation.

The time-namespace binding is intentional: Linux applies the observer's
boottime offset to process start ticks in
[`fs/proc/array.c`](https://github.com/torvalds/linux/blob/master/fs/proc/array.c).
See also [time_namespaces(7)](https://man7.org/linux/man-pages/man7/time_namespaces.7.html).

## Verification evidence

- RED reproduced missing durable ordering, lost cross-process recovery evidence,
  older-process rejection, and admission appends racing fatal controller closure.
  Each corresponding regression passed after repair.
- All 2,191 tests across 208 files passed in 201.56 seconds. Typecheck, build,
  lint, and format checks passed. Production audit is clean; the full audit has
  two existing moderate and one low development advisories, with no high or
  critical findings. Dependencies were unchanged.
- Independent review approved the final change after the fatal-closure race
  and real procfs capture-failure coverage were addressed. Abort during capture
  retains the explicit started/aborted record pair without invoking the tool.
- The rebuilt linked CLI inspected a synthetic persisted execution from a
  separate producer while an older same-UID process remained inaccessible.
  It returned the unresolved execution with no marked processes and unchanged
  log bytes. A synthetic legacy copy without admission evidence stayed blocked.
  No cleanup confirmation was issued in the linked-CLI smoke.
- Verified both the global `conduct` symlink and Pi's local package entry resolve
  to this checkout. Test processes exited through their private release files;
  real run logs, partial work, and unrelated processes were not modified.
