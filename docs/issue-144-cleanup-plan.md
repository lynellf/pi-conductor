# Issue #144: leader-exited cleanup

Authority: issue #144; FSM spec §11.1/§11.4 (observable terminal outcomes). Scope is the Linux supervised executable cleanup path only.

Assumptions: the recorded leader identity and execution marker were admitted before cleanup; escaped marker-bearing processes remain a distinct fail-closed outcome. A live unmarked/unknown group member cannot be signalled or ignored solely because the leader exited.

- [x] Reproduce leader-gone, marked group member that exits (and one that needs PID-only termination); assert no group signal.
- [x] Preserve fail-closed behavior for unmarked members, changed PID/start identity, observation failure, and escaped marked processes.
- [x] Implement bounded member-by-member revalidation and settlement; never use negative-PGID signalling after leader verification fails.
- [x] Run focused tests and full typecheck, build, test, lint, format and audit gates; review identity and race handling.

Risk: /proc snapshots are not atomic with signal delivery; revalidate as close to each PID signal as possible, and retain fail-closed uncertainty when proof is unavailable. No new dependency or persistence schema.

Verification: the two new leader-exit cases failed on origin/main and passed after the repair. Focused supervisor and packaged-bash tests pass; typecheck, build, lint, format check, and full suite (409 files / 4,361 tests) pass. `pnpm audit` reported 2 moderate Vitest dev-tool advisories and 1 low esbuild Windows dev-server advisory, no high/critical findings. A separate child-output-store concurrency test failed once in the first full run, then passed in isolation and the final full run; no child-output code changed. Packed bash may report either unconfirmed for an unadmitted fast-exit child or confirmed cleanup for an admitted marked group member; both remain covered.
