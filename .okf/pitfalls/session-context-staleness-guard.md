---
title: Session Context Staleness Guard
type: pitfall
status: active
source_files:
  - src/extension/session-context.ts
  - src/extension/commands/start.ts
  - src/extension/commands/resume.ts
  - extensions/conduct.ts
tags:
  - extension
  - lifecycle
  - staleness
  - session-replacement
  - callbacks
updated_at: 2026-08-09
---

# Summary

When pi replaces its extension context (session reload, extension restart),
any in-flight conductor command may still hold a reference to the old
extension's `ctx.ui` handle and callbacks. Touching a stale context after
replacement produces silent UI corruption or unhandled rejections. The
generation-based guard pattern detects this and short-circuits.

# Durable knowledge

- **Pattern:** `src/extension/session-context.ts` exposes two functions:
  `createSessionContextGuard()` returns a closure that captures the current
  generation number; `invalidateSessionContext()` bumps the counter, invalidating
  all previously-created guards. Every guard closure returns `false` after
  invalidation. The module is 19 LOC with zero dependencies.
- **Threading:** The `conduct.ts` extension entrypoint creates one guard per
  load (`isCurrentSessionContext = createSessionContextGuard()`), then passes
  it as `isContextCurrent` into every command handler via `withDeps`. Commands
  wrap every `ctx.ui.notify`, `ctx.ui.setStatus`, and run completion callback
  in `if (isContextCurrent())` guards.
- **Host-level guard:** `ProductionHost.spawnRole` checks `isUiContextCurrent()`
  before calling `session.bindExtensions({ uiContext })`. If the guard returns
  `false`, binding is skipped entirely. If binding fails (race between
  replacement and the bind call), the partially-created SDK session is
  `dispose()`d and the error propagates to the loop, which synthesizes a
  terminal record (see `.okf/pitfalls/fallback-failure-terminal-record.md`).
- **Extension lifecycle integration:** `conduct.ts` calls
  `invalidateSessionContext()` inside `pi.on("session_shutdown", ...)`, before
  detaching the status poller and aborting the active run. The abort is
  fire-and-forget (`void activeRun.abort(...).catch(() => {})`) to avoid
  turning a recoverable failure into an unhandled rejection in the pi process.
- **Default guard:** Commands accept `isContextCurrent` as an optional
  dependency defaulting to `() => true`. This keeps the guard non-intrusive
  for unit tests and non-extension callers (CLI) that do not face session
  replacement.
- **Do not omit the guard in new extension commands.** Any future command
  that touches `ctx.ui` or awaits a run must accept and check `isContextCurrent`.

# Evidence

- `src/extension/session-context.ts` — the guard module (19 LOC).
- `src/extension/commands/start.ts` — guard threaded through start, followup,
  resume, copy, steer, abort, abort-active-run, list (all commands with
  UI callbacks).
- `extensions/conduct.ts` — `session_shutdown` handler calls
  `invalidateSessionContext()` and aborts the active run.
- `src/host/production-host.ts` — `spawnRole` checks `isUiContextCurrent`
  before binding; disposes on failure.
- `tests/extension/conduct-start.test.ts`,
  `tests/extension/conduct-copy.test.ts`,
  `tests/extension/conduct-steering.test.ts` — regression fixtures isolating
  callback behavior after context invalidation.

# Related

- `.okf/pitfalls/fallback-failure-terminal-record.md` — the companion invariant
  that handles spawn failures after the guard detects staleness.
- `src/host/production-host.ts` — host-level guard that applies the same
  staleness check at the session-binding boundary.
