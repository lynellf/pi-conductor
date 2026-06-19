/**
 * Default v1 role bundle — spec §6, §15.4, plan Task 20.
 *
 * Provides the shipped default conductor manifest + role system
 * prompts as strings. The bundle is a **scaffold / template**,
 * not implicit reducer state:
 *
 *  - The manifest is a real `.pi/conductor.yaml` — it declares one
 *    `is_orchestrator: true` role and one worker. The Phase 1
 *    manifest checks (§13) enforce the contract; "missing
 *    orchestrator" remains a hard error. The reducer has no
 *    implicit knowledge of "default" roles.
 *  - Users copy the YAML + role prompts and customize the worker
 *    names, model lists, visit caps, and tools. The defaults are
 *    a starting point, not a constraint.
 *  - The Task 20 test suite loads the bundle, runs the Phase 1
 *    manifest checks, and exercises a linear + remediation E2E run
 *    via the stub provider — the checkpoint gate proves the
 *    shipped default path, not only hand-built test objects.
 *
 * ## Files
 *
 * The bundle lives as plain files under
 * `tests/fixtures/default-conductor/.pi/`:
 *
 *   - `conductor.yaml` — the sample manifest
 *   - `roles/orchestrator.md` — the orchestrator's system prompt
 *   - `roles/worker.md` — the worker's system prompt
 *
 * The YAML references the prompts by path (`system_prompt:
 * .pi/roles/orchestrator.md`). In a real deployment, the host
 * loads the prompt files when it spawns a role session. The
 * `defaults` module doesn't load them — it just exposes the raw
 * strings so callers can compose them into a `LoadedManifest` or
 * inspect them in tests.
 *
 * ## Path resolution
 *
 * The fixture directory is resolved relative to `process.cwd()`.
 * This is the standard Node.js convention for test fixtures and
 * keeps the module simple (no `import.meta.url` / `__dirname`
 * gymnastics). The module is intended for test + local-development
 * use; production deployments would write their own manifest
 * from scratch and ship it as part of the repo.
 *
 * Host-agnostic. No SDK runtime imports.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Public types ──────────────────────────────────────────────────────

/**
 * The shipped default v1 role bundle. `yaml` is the contents of
 * `conductor.yaml` (ready to feed to `loadManifestFromString`);
 * `prompts` maps role name → system prompt contents.
 */
export interface DefaultBundle {
  readonly yaml: string;
  readonly prompts: Readonly<Record<string, string>>;
}

// ─── Internals ─────────────────────────────────────────────────────────

/**
 * Path to the fixture directory, relative to the project root.
 * Resolved against `process.cwd()` at call time so the module
 * works from any working directory as long as the project root
 * is the cwd (the standard for `pnpm test` invocations).
 */
const FIXTURE_DIR = "tests/fixtures/default-conductor";

/** Read a file from the fixture directory as a UTF-8 string. */
function readFixture(relPath: string): string {
  return readFileSync(join(process.cwd(), FIXTURE_DIR, relPath), "utf8");
}

// ─── Public API ────────────────────────────────────────────────────────

/** The default `conductor.yaml` manifest as a string. Ready to
 *  pass to `loadManifestFromString`. */
export function getDefaultConductorYaml(): string {
  return readFixture(".pi/conductor.yaml");
}

/** The default orchestrator system prompt as a string. */
export function getDefaultOrchestratorPrompt(): string {
  return readFixture(".pi/roles/orchestrator.md");
}

/** The default worker system prompt as a string. */
export function getDefaultWorkerPrompt(): string {
  return readFixture(".pi/roles/worker.md");
}

/**
 * The full default v1 role bundle — the YAML + both role prompts.
 * Callers (tests, CLIs, future `init` commands) can compose this
 * into a `LoadedManifest` or write the strings to disk for a
 * real `.pi/conductor.yaml` deployment.
 */
export function getDefaultBundle(): DefaultBundle {
  return Object.freeze({
    yaml: getDefaultConductorYaml(),
    prompts: Object.freeze({
      orchestrator: getDefaultOrchestratorPrompt(),
      worker: getDefaultWorkerPrompt(),
    }),
  }) as DefaultBundle;
}
