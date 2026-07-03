---
title: Fake-timer isolation leak with Vitest isolate:false
type: pitfall
status: active
source_files:
  - tests/host/record-emitter.test.ts
  - tests/host/ask-user-tool.test.ts
  - tests/extension/status-poller-diff.test.ts
  - tests/extension/status-spinner.test.ts
tags:
  - testing
  - vitest
  - isolation
  - timers
updated_at: 2026-07-02
---
# Summary

When running Vitest with `isolate:false`, `vi.useFakeTimers()` from one test file can leak into another. Async tests that `await` setTimeout-like delays hang forever because the fake timer queue from the previous file never advances. Two complementary mitigations are required.

# Durable knowledge

- **Root cause**: Vitest's `isolate:false` mode reuses module state across test files. When a test file calls `vi.useFakeTimers()` in `beforeEach` and another file does not, the second file inherits the fake timer state from the first. Any `await new Promise((r) => setTimeout(r, N))` call in the second file then hangs indefinitely because no `vi.advanceTimersByTime()` is running.
- **Mitigation 1 — `beforeEach` guard**: Every test file that uses `vi.useRealTimers()` or `setTimeout` must call `vi.useRealTimers()` in a `beforeEach` block, even if the file never calls `vi.useFakeTimers()` itself. This ensures real timers are active regardless of which file ran before. Example from `record-emitter.test.ts` and `ask-user-tool.test.ts`.
- **Mitigation 2 — cleanup ordering in `afterEach`**: When a file uses `vi.useFakeTimers()` with `setInterval` (e.g., a poller), call `stopPoller?.()` to clear the interval **before** calling `vi.useRealTimers()`. If real timers are restored first, orphaned interval callbacks in the fake timer queue fire into the next test file after the real timer restore. Example from `status-poller-diff.test.ts` and `status-spinner.test.ts` — each captures the `stopPoller` handle from `startStatusPoller()` and invokes it in `afterEach` before `vi.useRealTimers()`.
- **Ordering rule**: Clean up intervals/pollers FIRST, then restore real timers. Reversing this order re-introduces the leak.

# Evidence

- Commit `6361892` — the fix commit with full reasoning in the commit message and 43 lines of changes across 4 test files.
- `tests/host/record-emitter.test.ts` — `beforeEach` guard with `vi.useRealTimers()`.
- `tests/host/ask-user-tool.test.ts` — `beforeEach` guard with `vi.useRealTimers()`.
- `tests/extension/status-poller-diff.test.ts` — `let stopPoller` pattern with cleanup before `vi.useRealTimers()`.
- `tests/extension/status-spinner.test.ts` — same `let stopPoller` pattern.

# Related

- (none yet — this is the first testing-related OKF doc)