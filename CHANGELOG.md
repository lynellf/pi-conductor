# Changelog

## [0.1.0] - 2026-06-20

### Core
- Pure deterministic FSM reducer (`reduce` / `reduceLifecycle`) with visit caps, cost-cap predicates, and two-reducer composition.
- Manifest parse / validate / derive (`toMachineDefinition`) with all spec §13 static checks.
- TypeBox emission schemas for `handoff` / `end` tools — single source of truth, shared by seam validation and tool-arg definitions.
- Pure cost roll-up (`RunRollup`) and session/run cap-evaluation predicates.
- `RecordLog` interface with `InMemoryRecordLog` (core) and `FileRecordLog` (host).
- Run-memory artifact (`buildRunMemory`) seeded into each orchestrator turn.

### Host driver
- Orchestration loop with legal-handoff spawning, illegal-handoff rejection (surfaces `legal_targets`), and post-emission session sealing.
- Resume from a file-backed log; cost-cap forced-`end` deferred to the orchestrator.
- Model-fallback escalation (primary → secondary models on `session_failed`).
- Production `Host` with `ModelRegistry` model resolution, `DefaultResourceLoader` prompt loading, and file-backed `SessionManager`.
- Stub-provider E2E test suite for CI (no API key required).

### Extension shell
- `/conduct <goal>`, `/conduct:resume <run_id>`, `/conduct:list`, `/conduct:abort` commands.
- `--conduct-manifest <path>` flag.
- HOME-scoped manifest fallback (`~/.pi/conductor.yaml`) with configurable `homeDir` for hermetic testing.
- Active model display in status footer and `/conduct:list` (`model=<provider:id>` or `model=<default>`).

### Packaging
- Ships as a pi extension (`package.json#pi.extensions`) with a CLI fallback (`bin/conduct`).
- Library API (`startRun`, `resumeRun`, `listRuns`, `createProductionHost`, `getDefaultBundle`).
- Default v1 bundle (one orchestrator + one worker).
