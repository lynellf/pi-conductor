# Issue #117 verification

Terra implemented the contracts, approval checks, ledger validation and controlled
Forge example. Sol implemented and reviewed the trusted process boundary. Root
wired production assembly, evidence/result privacy, durable waits and native
scheduler integration.

Review fixes included exact process-to-intent/owner binding, prepared-request and
repository binding, bounded sequential evidence aggregation, verification of
unmarked same-session descendants before cleanup confirmation, and exact remote
postconditions in the example. Provider code remains privileged; declarations do
not create an OS/network sandbox. See the operator guide and ADR-003.

## Evidence map

| Behavior | Verification |
| --- | --- |
| Fixed registration, schemas, refs and implementation identity | `controller-local-effect-contract.test.ts`, `controller-local-effect-registry.test.ts` |
| Durable identity, epochs and prepared postconditions | `controller-local-effect-attempt.test.ts`, `controller-local-effect-process*.test.ts`, `controller-effect-history.test.ts`, `controller-effect-timeline.test.ts` |
| Private stdin, scrubbed environment, deferred admission, changed dependencies | `controller-local-effect-runtime.test.ts`, `local-effect-supervision.test.ts` |
| Timeout, malformed/oversize/credential echo and unmarked descendant uncertainty | `controller-local-effect-runtime.test.ts` |
| Aggregate evidence bound | `controller-local-effect-evidence.test.ts` |
| Production approval, artifact consumption, audience restriction and recovery reuse | `controller-production-effects.test.ts` |
| PR create/reuse, pending observation, exact-head/check rejection, verified merge, crash/receipt-loss inspect without duplicate writes | `controller-local-effects-example.test.ts` |
| Overlapping resources and legacy Git lane compatibility | `controller-local-effect-lanes.test.ts`, `controller-effect-timeline.test.ts` |
| Deadline restart, no polling, abort, invalid delays | `controller-wakeup.test.ts` |
| Native completion wakes a bounded wait; successor completes while a sibling remains active | `controller-role-session.test.ts` |

All provider tests use local temporary repositories, fixed test programs and a
controlled loopback fake forge. No live publication or paid model run was used.

## Repository gates

Final gates completed on 2026-09-17. Production audit reports
no known vulnerabilities. Full dependency audit reports two moderate Vitest/mock
advisories and one low esbuild advisory in development dependencies, with no
high/critical advisories; dependency changes are outside this implementation.

The first full run exposed an existing timestamp-dependent snapshot fixture:
root permission changes sometimes shared `ctimeMs`, so the writable-file case
could correctly reach `runtime-unsafe-entry` instead of its expected root-mutation
error. A separate test-only commit isolates each rejection condition. Its 29
focused cases pass; production sandbox validation is unchanged.

The expanded local Forge, production-effect, and registry checks pass 26 tests.
The no-model example explicitly completes a native successor before releasing CI,
checks a quiet bounded wait, then observes passing CI and verifies merge. Missing
and failed check cases use the correct head, independently of head-mismatch tests.
Real Bubblewrap checks pass all 3 tests, including the executable controller
example through the built CLI and preflight/abort cleanup.

The installed `conduct` link resolves to this checkout's `dist/bin/conduct.js`.
Its startup usage smoke succeeds (the CLI returns its normal usage exit code 2).
The built public entrypoint exposes all five local-program envelope/grant schemas
and successfully measures the installed host driver and three built-in providers.

Final stable-tree gates:

- `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm format:check`: pass.
- `pnpm test`: **3,272 tests passed across 329 files**.
- Real Bubblewrap controller example and preflight suites: **3 tests passed**.
- `pnpm audit --prod`: no known vulnerabilities.
- `pnpm audit`: no high/critical findings; development advisories noted above.
- Linked CLI startup, built public contracts, and built implementation measurement: pass.

No provider approval files were changed and no live forge write was performed.
