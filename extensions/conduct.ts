/**
 * pi-conductor extension entrypoint — Phase 7B.
 *
 * Wraps the production host driver (`src/host/`) in a pi
 * extension that exposes four slash commands:
 *
 *   - `/conduct <goal>`         — start a run.
 *   - `/conduct:resume <run_id>` — resume a run from its log.
 *   - `/conduct:list`           — list known runs in the log.
 *   - `/conduct:abort`          — abort the active run.
 *
 * plus one CLI flag:
 *
 *   - `--conduct-manifest <path>` — override the default
 *     manifest path. Default: `<ctx.cwd>/.pi/conductor.yaml`.
 *
 * ## Why this is a UX shell, not the engine
 *
 * The spec (§9.5) and the extension pivot plan both make this
 * explicit: the orchestration engine is the SDK host driver in
 * `src/host/`, which spawns role sessions via the standalone
 * `createAgentSession` (not via `ctx.newSession()` or
 * `ctx.fork`). This extension is the **shell** — the four
 * commands are thin handlers that resolve the manifest,
 * construct a `ProductionHost` via `createProductionHost`,
 * and forward to `startRun` / `resumeRun` / `listRuns` /
 * `RunHandle.abort`.
 *
 * The grep-guard test `tests/extension/no-role-spawn-via-session-tree.test.ts`
 * asserts this separation: the extension never calls
 * `ctx.newSession` or `ctx.fork`. Role sessions are spawned
 * by `ProductionHost` only.
 *
 * ## Factory discipline
 *
 * `docs/extensions.md` is explicit: the factory may run in
 * invocations that never start a session (e.g. `pi --help`).
 * No `startRun` / `resumeRun` / file I/O / polling starts
 * from this function. The factory only registers commands
 * and the flag; all long-lived work begins in the command
 * handlers. The 7B.1 acceptance is verified by
 * `tests/extension/conduct.test.ts` (the harness test asserts
 * the active-run tracker is still `null` after factory
 * returns).
 *
 * ## `default` export (the explicit exception to AGENTS.md)
 *
 * AGENTS.md says "named exports only". `docs/extensions.md`
 * + pi's `ExtensionFactory` type require the entrypoint to
 * be the module's `default` export — pi's loader calls
 * `await jiti.import(extensionPath, { default: true })` and
 * resolves the default-exported function as the factory.
 * This file is the single explicit exception; all other
 * modules in `extensions/` use named exports.
 *
 * ## Module size
 *
 * This file is the registration entrypoint only. The four
 * command handlers live in `extensions/commands/*.ts` to
 * keep each file under the AGENTS.md ~400-LOC ceiling. The
 * factory itself registers + dispatches; the work happens
 * in the handlers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { handleAbort } from "../src/extension/commands/abort.js";
import { handleList } from "../src/extension/commands/list.js";
import { handleResume } from "../src/extension/commands/resume.js";
import {
  type GetFlagValue,
  type HandleDeps,
  handleStart,
} from "../src/extension/commands/start.js";
import { createConductMessageRenderers } from "../src/extension/conduct-message-renderer.js";
import { getCurrentOrchestratorRole } from "../src/extension/current-orchestrator.js";
import { createConductDisplaySink } from "../src/extension/display-sink-wiring.js";

/**
 * Manifest path override flag. Default is resolved at
 * command time by `resolveManifestPath(flagValue, ctx.cwd)`
 * — the extension does not pin a default on the flag
 * itself (the resolver owns the rule).
 */
const CONDUCT_MANIFEST_FLAG = "conduct-manifest";

/**
 * Adapt the SDK's `(args, ctx)` handler shape to the
 * extension's `(args, ctx, deps)` shape. The deps carry
 * the flag reader — a `pi.getFlag` closure the factory
 * creates once and shares across all four handlers.
 */
function withDeps(
  handler: (
    args: string,
    ctx: Parameters<typeof handleStart>[1],
    deps: HandleDeps,
  ) => Promise<void>,
  getFlag: GetFlagValue,
  displaySink: HandleDeps["displaySink"],
): (args: string, ctx: Parameters<typeof handleStart>[1]) => Promise<void> {
  return (args, ctx) =>
    handler(args, ctx, {
      getFlag,
      ...(displaySink !== undefined && { displaySink }),
    });
}

/**
 * The extension factory. Called once per pi process.
 * Synchronous (no async work needed for registration;
 * the harness `await`s the return value, so a returned
 * `Promise<void>` would also work, but registration is
 * fast enough that sync is clearer).
 */
export default function conductExtension(pi: ExtensionAPI): void {
  pi.registerFlag(CONDUCT_MANIFEST_FLAG, {
    description: "Override the conductor manifest path (default: <cwd>/.pi/conductor.yaml)",
    type: "string",
  });

  // Single flag reader shared across all four handlers.
  // The closure reads the latest flag value at command
  // time, so a `--flag` set on the pi CLI line flows
  // into the handler invocation.
  const getFlag: GetFlagValue = (name) => pi.getFlag(name);
  const displaySink = createConductDisplaySink((message) => pi.sendMessage(message));

  // Conductor-owned message renderers for the two
  // `conduct.role.*` `CustomMessage` `customType`s. The
  // renderers take over `CustomMessage` rendering for
  // streamed entries and present them with a structural
  // role label + a properly-themed markdown body (see
  // `src/extension/conduct-message-renderer.ts` for the
  // design and `docs/tui-bridge-plans/phase-5-renderer-polish.md`
  // for the rationale). The orchestrator-role getter is
  // resolved per-render against the live
  // `currentOrchestratorRole` slot, so the same renderer
  // instance works across runs.
  for (const [customType, renderer] of Object.entries(
    createConductMessageRenderers(getCurrentOrchestratorRole),
  )) {
    pi.registerMessageRenderer(customType, renderer);
  }

  pi.registerCommand("conduct", {
    description: "Start a pi-conductor run for <goal> using .pi/conductor.yaml.",
    handler: withDeps(handleStart, getFlag, displaySink),
  });

  pi.registerCommand("conduct:resume", {
    description: "Resume a previously-started run by run_id.",
    handler: withDeps(handleResume, getFlag, displaySink),
  });

  pi.registerCommand("conduct:list", {
    description: "List known runs in the conductor log.",
    handler: withDeps(handleList, getFlag, displaySink),
  });

  pi.registerCommand("conduct:abort", {
    description: "Abort the active run (no-op if none).",
    handler: withDeps(handleAbort, getFlag, displaySink),
  });
}
