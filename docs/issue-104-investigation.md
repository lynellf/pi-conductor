# Issue #104: supervised file-tool stalls

Investigation date: 2026-09-10. Runtime examined: conductor `92e2724`
(package 0.21.7), installed Pi 0.85.1, Node 26.5.0, Linux.
References: orchestrator FSM spec §11.1 and §11.8; execution controls
issues #76, #102, and #103.

## Conclusion and limits

Status polling can make a successful file worker exceed its supervision
deadline. This was reproduced with the normal status poller, a preserved
historical log prefix, and the reported read. The worker produced output
and exited with code zero; subsequent process observations were starved
by synchronous status work.

This is a concrete defect and a strong candidate explanation for the reported
progressive slowdown. It does **not** prove the exact cause of the original
`leader_identity_unobserved` diagnostic. The reproduction observed the
leader and eventually confirmed cleanup; the original log lacks spawn,
admission, output, and exit timings. No production fix is included here.

## Historical evidence

The run contains 888 executable-tool starts and finishes: 854 completed,
22 failed, 11 cleanup-unconfirmed, and one aborted. Every start has persisted
admission evidence. Peak recorded executable-tool concurrency was 13.

All times below are UTC on 2026-09-10. Durations include admission and
supervisor work; they are not measurements of file I/O alone.

| Time / interval | Observation |
| --- | --- |
| 17:00–17:05 | Successful read median 813 ms; grep 814 ms; ls 803.5 ms. |
| 17:05–17:10 | Successful read median 1,748 ms; grep 2,012 ms. |
| 17:10–17:15 | Successful read median 13,643 ms; grep 14,405 ms. |
| 17:15:14–17:16:58 | The failing child's preceding read completed in 103,809 ms. |
| 17:17:01–17:22:08 | Its next read ended after 306,904 ms with `leader_identity_unobserved`. |
| 17:22:15 | Four other file tools ended cleanup-unconfirmed; two had not reached their own five-minute deadlines. |
| 17:25:54–17:32:12 | Six parent writes ended cleanup-unconfirmed after 377,058–378,349 ms. |

The clustered child terminals are consistent with the scheduler closing
other active children after the first ambiguous execution. They should not
be counted as eleven independent identical worker hangs. Ten of the eleven
unconfirmed terminals have no process diagnostic, so their precise internal
stage cannot be reconstructed.

Host sysstat samples spanning 17:00–17:30 show 74–90% aggregate CPU idle on
six CPUs, approximately 5.1–5.2 GB available memory, no measured memory
pressure or swap-out, and little I/O pressure. Ten-minute samples cannot
exclude short spikes, but do not support sustained host-wide resource
exhaustion. One busy JavaScript event loop fits those aggregate measurements.

## Controlled reproduction

Experiments used the existing child worktree read-only and the installed Pi
SDK, selected through a Node module-resolution hook. No model session or
compiler campaign was started. Raw run and child-session logs were copied to
a private temporary directory and SHA-256 hashed. Only lifecycle metadata,
durations, numeric process identities, and output byte counts were extracted.

The reported file contains 94,376 bytes. Direct reading took 4.8 ms. The
actual supervised SDK worker, including a separate durable-admission capture,
completed at these measured latencies:

| Concurrent workers | Completion range | Admission capture range |
| --- | --- | --- |
| 1 | 699 ms | 34 ms |
| 4 | 928–941 ms | 61–63 ms |
| 8 | 1,259–1,401 ms | 91–96 ms |

Maximum measured event-loop delay stayed below 23 ms. Worker peak sampled
RSS was approximately 137–151 MB; parent peak RSS was below 193 MB.

The next experiment used a 1,994-record prefix ending before the first
unconfirmed terminal, preserving original run identities. It constructed
a real `FileRecordLog`, `RunHandle`, and `startStatusPoller`; rendering was a
no-op. The read used an eight-second diagnostic deadline and 500 ms cleanup
grace. A ten-second timer on the same host event loop stopped the poller.

| Condition | Result |
| --- | --- |
| Polling disabled | Read completed in 698 ms. |
| Normal 250 ms polling enabled | Supervised timeout; settled after 10,219 ms with cleanup confirmed. |

With polling enabled, output and exit code zero were observed about 815 ms
after `onStart`; close arrived about 1,079 ms after `onStart`. There were
39 status ticks lasting 250–322 ms, and maximum sampled event-loop delay
was 300 ms. The load experiment stopped at this first failure.

The probe recorded process lifecycle callbacks and `/proc` read durations;
it did not log environment values, tool output text, or session reasoning.
It exercised real worker and status code without the complete Pi TUI,
other extensions, or historical model sessions.

## Cause in the code

`src/extension/status.ts` schedules synchronous `handle.runStats()` every
250 ms. In `src/host/run-handle.ts`, each call reads the full run log once,
then `computeExitReason()` calls `latestCheckpoint()` and `records()` again.
`FileRecordLog.latestCheckpoint()` also calls `records()`: three complete
reads per tick.

Each `FileRecordLog.records()` synchronously reads and parses the JSONL,
validates every record, and checks timelines. `runStats()` then reconstructs
and validates the tool-execution timeline again. Once a tick takes roughly
the entire polling interval, asynchronous process observations make very
little progress between ticks. A worker can finish while its supervisor
remains busy establishing or checking ownership.

`leader_identity_unobserved` covers several paths: no initial leader
identity followed by a deadline/abort while waiting for close, and a
deadline/abort before or after post-close process scans. It is not proof
that spawning failed or that the worker itself remained blocked. An exited
worker whose identity was missed is a plausible route into this outcome;
historical evidence cannot identify which route occurred.

## Separate deadline-accounting defect

`ToolExecutionController.run()` records `startedAt` before awaiting
`captureAdmission()`, and computes the absolute deadline from that timestamp.
However, its cancellation timer is installed **after** capture using the
original `timeoutMs`, rather than the remaining time. The supervisor gets a
remaining deadline, but a pending pre-spawn observation can prevent it from
reaching its own deadline check promptly.

A process-free probe used a one-second policy, 600 ms admission delay, and
an operation that acknowledged cancellation. It entered the operation with
398 ms remaining, but received cancellation at 1,602 ms and recorded its
terminal at 1,603 ms after invocation: approximately 600 + 1,000 ms.
This extends controller cancellation by the capture duration; scheduling
delay and cleanup settlement can add further time. It is relevant to the
late write terminals, but their logs do not establish each stage's duration.

## Recovery and implementation direction

Read-only linked-CLI reconciliation succeeded for the original run:
11 unresolved executions, zero currently marked processes, and an unchanged
log hash. No cleanup confirmation was recorded. This independently verifies
the #103 recovery path while retaining the original cleanup uncertainty;
empty markers do not prove absence of unmarked descendants.

A focused repair should:

1. Derive status and exit reason from one consistent record snapshot.
2. Keep spinner updates cheap, avoid revalidating unchanged history on each
   tick, and give observation I/O time to progress even when a refresh is slow.
   Any cache must preserve append/replacement/corruption detection and full
   validation at the persistence boundary.
3. Install cancellation against the remaining absolute deadline after
   admission, with deterministic coverage for delayed capture.
4. Add bounded phase/timing evidence distinguishing spawn failure, initial
   identity absence, successful worker exit, and incomplete process scans.
5. Guard the repair with synthetic large-log status/worker coverage and the
   existing ownership, timeout, admission, and reconciliation tests. Recheck
   the small read before any further campaign.

Increasing timeouts, ignoring inaccessible processes, or treating empty
markers as confirmed cleanup would not address the reproduced defect.

## Investigation verification

- [x] Preserve original evidence; leave workload unchanged.
- [x] Reconstruct outcomes, slowdown, and terminal clusters.
- [x] Compare direct access and bounded supervised-worker concurrency.
- [x] Reproduce a supervisor timeout caused by normal status polling.
- [x] Verify admission-related cancellation drift without spawning processes.
- [x] Verify read-only reconciliation and the linked executable target.
- [x] Obtain independent review of the polling finding and its limitations.
- [ ] Reproduce the exact historical `leader_identity_unobserved` path.
- [ ] Implement and verify a production repair.
