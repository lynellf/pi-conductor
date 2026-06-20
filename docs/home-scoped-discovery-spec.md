# Spec delta — HOME-scoped manifest + system-prompt discovery

Status: **Implemented (Phase 7D, 2026-06-20). The §8 / §8.1 / §13 / §11
clarifications are now part of `docs/orchestrator-fsm-spec.md` (the
authoritative spec). This delta is preserved for traceability.**
Authority: amends `docs/orchestrator-fsm-spec.md` §8, §8.1, §13; mirrors the
resolution behavior already in `src/extension/manifest.ts` and
`src/host/production-host-resolve.ts`.
Parent plan: `docs/extension-pivot-plans/phase-7d-home-scoped-discovery.md`.

## What I found (investigation)

### Current manifest resolution (`src/extension/manifest.ts`)

`resolveManifestPath(flagValue, cwd)` implements exactly two sources, in order:

1. `--conduct-manifest <path>` flag (string). Relative paths joined against
   `cwd`; absolute paths used as-is. If the flag value is set but the file does
   not exist, resolution returns `null` **immediately** — it does **not** fall
   through to the default. (Subtle: a flag pointing at a missing file is a hard
   "no manifest," not a soft "try the default next.")
2. `<cwd>/.pi/conductor.yaml` (the project-local default, `DEFAULT_MANIFEST_PATH`).

If neither yields a file, `null` is returned and the command handler notifies a
warning and starts no run. There is **no parent-walk** and **no HOME search**
today. The module JSDoc is explicit: *"There is no fuzzy 'search parents for a
manifest' logic in v1."*

### Current system-prompt resolution (`src/host/production-host-resolve.ts`)

`loadSystemPrompt(role, path, cwd)`:

- `path === undefined` → `null` (role has no prompt; SDK default stays).
- `path` absolute → used as-is.
- `path` relative → `resolve(cwd, path)` — **always against the host's `cwd`
  (`ctx.cwd`)**, never against the manifest file's directory.

`SystemPromptNotFoundError` is thrown on any read failure. The error message
says "resolved against cwd," which is the current truth.

### Where the manifest's directory is *not* carried today

- `loadManifest(path)` reads the file at `path` but does **not** record the
  file's directory on the returned `LoadedManifest`.
- `ProductionHost.cwd` is set from `ctx.cwd` (the extension's working
  directory), not from the manifest's location.
- `loadSystemPrompt` receives `this.cwd`, so relative prompt paths resolve
  against `ctx.cwd` regardless of where the manifest lived.

This means: **even if we found a manifest under `$HOME`, its relative
`system_prompt` paths would still resolve against `ctx.cwd`** — which defeats
the "share manifests/roles across repos" goal, because the role `.md` files
would have to be duplicated per-repo under `<cwd>/.pi/roles/`.

### Current path convention in shipped manifests

Both `.pi/conductor.yaml` (this repo) and the test fixture
`tests/fixtures/default-conductor/.pi/conductor.yaml` use:

```yaml
system_prompt: .pi/roles/orchestrator.md
```

i.e. the path is written **relative to `cwd`**, not relative to the manifest
file. Because the manifest lives at `<cwd>/.pi/conductor.yaml` and prompts
live at `<cwd>/.pi/roles/*.md`, `resolve(cwd, ".pi/roles/orchestrator.md")`
works today. Under a "resolve against the manifest's directory" rule, the same
string would resolve to `<cwd>/.pi/.pi/roles/orchestrator.md` — **broken**.

### What the spec currently says

- §8: *"Manifest source (resolved): a single `.pi/conductor.yaml` file."* and
  *"Per-role system prompts are referenced by path (`system_prompt:`) and
  loaded by the host."*
- §8.1: describes model resolution but does **not** specify the prompt-path
  resolution root. The implementation chooses `cwd`.
- §13: static checks run "at host load time against the `.pi/conductor.yaml`"
  — no mention of where that file is found.
- §10: `manifest_version` is pinned at run-start from the `version:` field.
  No change needed for HOME discovery — the version is wherever the manifest
  lives.
- §11.1: resume reconstructs from the host-owned `run_id`-keyed log; the
  manifest path is re-loaded to re-derive `def`. The log is keyed by `run_id`,
  not by manifest location, so a HOME-sourced run resumes correctly as long as
  the same manifest path resolves again.

### Invariants touched

- **Host-agnostic core (AGENTS.md §1):** `resolveManifestPath` lives in
  `src/extension/` (not scanned by the grep guard); `loadSystemPrompt` lives in
  `src/host/` (may import pi, not core). No core module changes. ✓
- **`def` is the pinned manifest snapshot (AGENTS.md §3):** HOME discovery only
  changes *which file* is loaded; the pinning semantics (§10) are unchanged. ✓
- **No silent fallbacks (AGENTS.md code conventions):** the current flag
  behavior already has a subtle "flag set but file missing → hard null, no
  fallthrough" rule. HOME discovery must preserve explicit, non-fuzzy search
  and must not silently pick a HOME manifest when the user clearly intended a
  cwd/flag path.

## Proposed spec changes

### §8 — Manifest source (resolved)

Replace the single-source sentence with an ordered resolution chain. The
manifest is still *a single file* once resolved; the chain only widens where
that file may be found.

> **Manifest source (resolved):** a single `conductor.yaml` file, resolved by
> the host in the following order. Each step is a single fixed-path existence
> check — there is **no parent-walk, no globbing, no fuzzy search**.
>
> 1. `--conduct-manifest <path>` flag value (string). Relative paths resolve
>    against `cwd`; absolute paths are used as-is. **If the flag is set, the
>    flag path is authoritative**: a missing file at the flag path is a hard
>    "no manifest" (returns `null`) and the chain does **not** fall through to
>    steps 2–3. The user who passes `--conduct-manifest` expects that path to
>    be used, not a silent substitute.
> 2. `<cwd>/.pi/conductor.yaml` — the project-local default.
> 3. `<home>/.pi/conductor.yaml` — the user-global fallback, where `<home>` is
>    `os.homedir()`. This lets a user keep one manifest + role-prompt set
>    shared across repos that do not ship their own `.pi/conductor.yaml`.
>
> The first step whose file exists wins. If none exists, resolution returns
> `null` and the command handler notifies a warning and starts no run (unchanged
> from v1).
>
> **Precedence rationale.** The project is the authority for its own workflow;
> a project-local manifest overrides a shared global one. The global fallback
> only fills the gap when a repo has no conductor manifest of its own. The flag
> is the explicit override and never falls through — passing a bad flag is a
> user error, not an invitation to guess.

### §8.1 — System-prompt path resolution root (NEW subsection)

This is the load-bearing change. Today relative `system_prompt` paths resolve
against `cwd`. To make a HOME manifest's prompts resolvable without per-repo
duplication, the resolution root must become the **manifest file's parent
directory**.

> **System-prompt path resolution.** A role's `system_prompt` path is resolved
> against the **directory containing the resolved manifest file** (the
> "manifest base"), not against `cwd`. Absolute paths are used as-is. This makes
> a manifest self-contained: the manifest and its `roles/*.md` prompts move
> together, whether the manifest lives under `<cwd>/.pi/` or `<home>/.pi/`.
>
> **Migration.** Existing manifests that write `system_prompt:
> .pi/roles/foo.md` (cwd-relative) must change to `system_prompt:
> roles/foo.md` (manifest-base-relative) when the manifest itself lives at
> `.../.pi/conductor.yaml`. This is a **breaking change to the path convention**,
> gated by a `version:` bump (§10): a manifest using the new convention
> declares a new `version:` integer, and the migration is recorded in the
> manifest's version history. (Open question Q2 below: whether to support both
> conventions during a transition window.)

### §13 — Static checks

Add one sentence clarifying that the checks run against *whichever* manifest the
resolution chain produced, unchanged in content:

> The §13 checks run at host load time against the resolved `conductor.yaml`
> (per the §8 resolution chain), regardless of whether it was found under
> `<cwd>` or `<home>`. No check differs by source location.

### §11.1 / §11.9 — Resume + run log location (clarification only)

No structural change. Clarify that:

- The run log (`<cwd>/.pi-conductor/runs/`) stays **`cwd`-scoped** regardless of
  manifest source. The manifest is configuration; the run log is per-project
  execution state. `/conduct:list` continues to enumerate runs per-project.
- `resumeRun(manifestPath, runId, …)` re-resolves the manifest path through the
  same §8 chain. If the original run started from a HOME manifest and that
  manifest still exists at resume time, resume succeeds. Deleting the manifest
  between start and resume breaks resume — the same fragility as cwd today, not
  new.

## Resolved design questions (overseer decisions, 2026-06-20)

All five questions were resolved in favor of the spec's recommendations.

### Q1 — HOME manifest location → `~/.pi/conductor.yaml` (option a)

**Resolved:** `~/.pi/conductor.yaml`. Mirrors the project-local
`.pi/conductor.yaml` shape exactly; pi's own `~/.pi/` usage is namespaced by
subdirectory (`agent/`, `sessions/`), so a top-level `conductor.yaml` does not
collide. Role prompts live under `~/.pi/roles/*.md`.

### Q2 — System-prompt path convention → version-gated back-compat (option a)

**Resolved:** version-gated. `version >= 2` resolves prompt paths against the
manifest base; `version == 1` keeps cwd-relative (back-compat). Existing v1
manifests keep working unchanged; new / HOME manifests declare v2. Preserves
the §10 "config changes are additive and versioned" rule. The cost is one
`if (version >= 2)` branch in `loadSystemPrompt`.

### Q3 — Flag fallthrough → hard-null, no fallthrough (keep current behavior)

**Resolved:** keep the hard-null behavior. A set-but-missing `--conduct-manifest`
flag returns `null` and does not fall through to cwd/HOME. Preserves "no silent
fallbacks."

### Q4 — CLI fallback → leave as-is, explicit path only (option a)

**Resolved:** `bin/conduct` stays explicit-path-only. No HOME discovery in the
CLI. The extension (interactive surface) is where discovery ergonomics matter.

### Q5 — Run log location → cwd-scoped, always (keep current behavior)

**Resolved:** the run log stays `<cwd>/.pi-conductor/runs/` regardless of
manifest source. `/conduct:list` is per-project; a run is executed *in* a
project, even if its config is shared.

## Scope summary (for the plan delta — `docs/extension-pivot-plans/phase-7d-home-scoped-discovery.md`)

Implementation touches (no core modules):

1. `src/extension/manifest.ts` — add step 3 (`<home>/.pi/conductor.yaml`) to
   `resolveManifestPath`; add a `homeDir` parameter (defaulting to
   `os.homedir()`) so tests can inject a temp HOME. HOME path is
   `~/.pi/conductor.yaml` (Q1).
2. `src/host/manifest.ts` — carry the resolved manifest file's directory onto
   `LoadedManifest` (new field `manifestDir: string`) and its `version` integer
   (new field `manifestVersion: number`) so the host knows the manifest base
   and which path convention to use.
3. `src/host/production-host-resolve.ts` — `loadSystemPrompt` gains a
   `manifestDir` + `manifestVersion` parameter; resolves relative paths
   against `manifestDir` for `version >= 2` (Q2) and against `cwd` for
   `version == 1` (back-compat). Absolute paths are always used as-is.
   `ProductionHost.spawnRole` threads `manifestDir` + `manifestVersion` through.
4. `src/host/production-host.ts` / `src/host/production-host-factory.ts` —
   thread `manifestDir` + `manifestVersion` from `LoadedManifest` into the
   host so `spawnRole` can pass them to `loadSystemPrompt`.
5. `src/host/errors.ts` — update `SystemPromptNotFoundError` message to reflect
   the new resolution root(s) ("resolved against manifest dir" for v2,
   "resolved against cwd" for v1).
6. `src/extension/commands/start.ts` — update the no-manifest notification to
   mention the HOME path tried.
7. `docs/extension-usage.md` — document the three-step resolution + the
   manifest-base prompt convention (v2).
8. `docs/orchestrator-fsm-spec.md` — apply the §8 / §8.1 / §13 / §11 clarifications
   described above (spec edits are the overseer's concern; these are staged
   for review).
9. Tests — `resolveManifestPath` HOME fallback; `loadSystemPrompt`
   manifest-base resolution; version-gated back-compat; grep-guard unaffected
   (no core changes).

No changes to: `src/core/`, `src/manifest/` (parse/validate/types/definition),
`src/seam/`, `src/cost/`, `src/persistence/`. The grep guard stays green.
No changes to `bin/conduct.ts` (Q4 — CLI stays explicit-path-only).
