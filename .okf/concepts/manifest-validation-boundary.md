---
title: Manifest Validation Contract Boundary
type: concept
status: active
source_files:
  - src/manifest/validate.ts
  - src/host/manifest.ts
  - src/host/production-host-resolve.ts
tags:
  - manifest
  - validation
  - architecture
  - boundary
updated_at: 2026-07-01
---
# Summary

The conductor enforces a strict architectural boundary between **static
structural validation** (in `src/manifest/`, host-agnostic core) and
**runtime availability checks** (in `src/host/`, requiring pi's
`ModelRegistry`). This boundary preserves the host-agnostic core invariant
(AGENTS.md, grep guard).

# Durable knowledge

- **`src/manifest/validate.ts` — `validateManifest`** inspects only the
  parsed `Manifest` data structure (structural rules: version, role names,
  tool requirements, model alias shape). It never imports pi types.
  All checks are static: no network, no runtime registry.
- **`src/host/manifest.ts` — `checkModelProvidersRegistered`** is the
  runtime availability check. It accepts a `ModelRegistry` and emits
  `"unregistered-provider"` warnings when `role.models[].entry` pairs
  are not found in pi's runtime registry. Called at manifest-load time
  when a registry is provided (optional second argument to
  `loadManifest`/`loadManifestFromString`).
- **Advisory, not hard:** The preflight check produces warnings, not
  errors. Providers can be registered by pi extensions that load after
  conductor, or dynamically during setup. The runtime `ModelNotFoundError`
  (from `spawnRole`) is the authoritative fallback.
- **Spec §13 stays scoped to static structural checks.** The preflight
  check is documented as a host-side addition, not a §13 extension.
  The `checkModelProvidersRegistered` function is in `src/host/manifest.ts`,
  and its JSDoc explicitly notes the boundary.
- **Timing:** The preflight runs at manifest-load time, not at first
  `spawnRole`. On `resumeRun`, it runs again on the freshly-loaded
  manifest (since registry contents may have changed).
- **CLI and extension paths both surface warnings:** Extension uses
  `ctx.ui.notify` (before setting active run); CLI uses stderr (before
  `handle.completion()`).
- **`RunHandle.loadedManifest`** was added to expose the `LoadedManifest`
  (and its warnings) via the handle, enabling both extension and CLI
  paths to read preflight results.

# Evidence

- `docs/archive/issues-5-and-6/plan.md` — Architecture decisions section
  documents the three considered options and the chosen boundary.
- `docs/archive/issues-5-and-6/phase-2-provider-preflight.md` —
  "Architectural rationale" section explains why the check is not in
  the §13 validator, not in `toMachineDefinition`, and not inside
  `ProductionHost`.
- `docs/archive/issues-5-and-6/archive.md` — Outcome confirms the
  boundary was implemented as designed.
- `src/manifest/validate.ts` — has zero pi imports (verified by grep
  guard).
- `src/host/manifest.ts` — `checkModelProvidersRegistered` function,
  JSDoc documenting it as a host-side advisory check.
- `tests/grep-guard.test.ts` — asserts `src/manifest/**` has zero pi imports.

# Related

- `.okf/concepts/model-id-provider-colon-format.md` — model resolution
  flow that the preflight check validates against.
- `docs/record-emitter-spec.md` — another example of a clearly bounded
  contract surface (in-process emitter vs durable JSONL log).