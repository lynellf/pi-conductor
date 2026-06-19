/**
 * `ProductionHost` — Phase 7A production `Host` (Tasks 7A.1,
 * 7A.2, 7A.3).
 *
 * Production `Host` implementation that resolves
 * `role.models[modelIndex]` (`provider:id`) against a real
 * `ModelRegistry`, loads `role.system_prompt` from disk, and
 * wires a real `DefaultResourceLoader` + file-backed
 * `SessionManager` for each role session. Reuses the host-owned
 * `run_id`-keyed append-only log and `LoadedManifest` the loop
 * already programs against.
 *
 * **Status (Phase 7A):** 7A.1 delivers the constructor + `Host`
 * interface conformance + the three boundary errors
 * (`ModelNotFoundError`, `MalformedModelEntryError`,
 * `SystemPromptNotFoundError`). 7A.2 adds the **pure resolution
 * pieces** used by `spawnRole` (`selectModelEntry`,
 * `resolveModel`, `loadSystemPrompt`). 7A.3 wires
 * `DefaultResourceLoader` + `SessionManager` into `spawnRole` and
 * adds the `buildToolsAllowlist` helper. 7A.4 matches
 * `StubHost`'s event-handling semantics (usage capture,
 * terminal reason, model fallback, visit index, abort, seal,
 * persistence, run-memory seeding).
 *
 * The class is constructible, type-conformant, and its
 * `spawnRole` produces a real `AgentSession` after 7A.3. The
 * remaining `Host` methods (`captureUsage`,
 * `sessionTerminalReason`, `abortSession`, `sealSession`,
 * `nextVisitIndex`, `getNextModel`, `runCostSoFar`,
 * `seedRunMemory`, `persistRecord`) still throw "not yet
 * implemented" until 7A.4 lands.
 *
 * **Host-agnosticism:** this module imports from
 * `@earendil-works/pi-coding-agent` (it's in `src/host/` — the
 * grep-guard test allows pi imports here). The pure core
 * (`src/core`, `src/manifest`, `src/seam`, `src/cost`) is
 * untouched and remains host-agnostic.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { RunMemory } from "../core/run-memory.js";
import type { Role, UsageRecord } from "../core/types.js";
import type { RoleConfig } from "../manifest/types.js";
import type { PersistedRecord, RecordLog } from "../persistence/log.js";
import type { Host, RoleSession, SessionTerminalReason, SpawnRoleOptions } from "./host.js";
import type { LoadedManifest } from "./manifest.js";
import {
  buildToolsAllowlist,
  loadSystemPrompt,
  resolveModel,
  selectModelEntry,
} from "./production-host-resolve.js";
import { SessionSeam } from "./seam.js";
import { createEndTool, createHandoffTool } from "./tools.js";

/**
 * Constructor options for `ProductionHost`. Mirrors the production
 * context the orchestration loop needs to pass through: the
 * `ModelRegistry` (typically the extension's
 * `ExtensionCommandContext.modelRegistry`, shared with pi's
 * configured providers), the working directory (typically
 * `ctx.cwd`), and the run-scoped state (`log`, `loadedManifest`,
 * `runId`) the loop already gives `StubHost`.
 */
export interface ProductionHostOptions {
  /** Real `ModelRegistry` from the host's environment (extension
   *  `ExtensionCommandContext.modelRegistry` or
   *  `ModelRegistry.create(authStorage, modelsPath)` in standalone). */
  readonly modelRegistry: ModelRegistry;
  /** Working directory for prompt-path resolution and session cwd. */
  readonly cwd: string;
  /** Host-owned `run_id`-keyed append-only log (Task 13.5). */
  readonly log: RecordLog;
  /** Pinned manifest snapshot (def + role configs + warnings). */
  readonly loadedManifest: LoadedManifest;
  /** The run this host is bound to. */
  readonly runId: string;
  /**
   * Optional: directory for SDK `SessionManager` files. The plan
   * calls for the file-backed `SessionManager` to be "rooted under
   * the conductor run log directory" — i.e., NOT in pi's own
   * session tree (~/.pi/agent/sessions/<encoded-cwd>/). Default:
   * `<cwd>/.pi-conductor/runs/<runId>/sessions`. Created on
   * construction (`mkdirSync({ recursive: true })`).
   */
  readonly sessionDir?: string;
  /**
   * Optional: directory for the SDK's `DefaultResourceLoader` agent
   * config (auth.json, models.json, extensions, etc.). Default:
   * `<cwd>/.pi-conductor/agent`. The extension is expected to
   * share its own `~/.pi/agent` by passing the path here, so
   * spawned role sessions see the user's pi configuration. The
   * default keeps the conductor's role sessions isolated from pi.
   */
  readonly agentDir?: string;
}

/**
 * Production `Host` — `Phase 7A` scaffold + role-session spawn
 * (Tasks 7A.1, 7A.2, 7A.3).
 *
 * `implements Host` enforces compile-time conformance to the
 * seam the loop programs against. Adding/removing/renaming a
 * `Host` method in `host.ts` will fail typecheck here, which
 * is the right shape for a scaffold: any drift between the
 * seam and the implementation is caught at the boundary, not
 * at runtime.
 */
export class ProductionHost implements Host {
  // ─── Stored production context ────────────────────────────────────
  /** See {@link ProductionHostOptions.modelRegistry}. */
  readonly modelRegistry: ModelRegistry;
  /** See {@link ProductionHostOptions.cwd}. */
  readonly cwd: string;
  /** See {@link ProductionHostOptions.log}. */
  readonly log: RecordLog;
  /** See {@link ProductionHostOptions.loadedManifest}. */
  readonly loadedManifest: LoadedManifest;
  /** See {@link ProductionHostOptions.runId}. */
  readonly runId: string;
  /** See {@link ProductionHostOptions.sessionDir}. */
  readonly sessionDir: string;
  /** See {@link ProductionHostOptions.agentDir}. */
  readonly agentDir: string;

  constructor(opts: ProductionHostOptions) {
    this.modelRegistry = opts.modelRegistry;
    this.cwd = opts.cwd;
    this.log = opts.log;
    this.loadedManifest = opts.loadedManifest;
    this.runId = opts.runId;
    this.sessionDir =
      opts.sessionDir ?? join(opts.cwd, ".pi-conductor", "runs", opts.runId, "sessions");
    this.agentDir = opts.agentDir ?? join(opts.cwd, ".pi-conductor", "agent");
    // The SessionManager writes JSONL files directly into `sessionDir`
    // without creating parent directories. Ensure the dir exists so
    // the first `SessionManager.create(cwd, this.sessionDir)` call
    // in `spawnRole` doesn't ENOENT.
    mkdirSync(this.sessionDir, { recursive: true });
  }

  // ─── Host methods ──────────────────────────────────────────────────
  // `spawnRole` is wired (7A.3). The remaining methods throw a
  // phase-tagged "not yet implemented" error so 7A.4 fills them
  // in (one task at a time, per the plan's slice structure).

  async spawnRole(role: Role, opts: SpawnRoleOptions = {}): Promise<RoleSession> {
    // 7A.3 wires the real `createAgentSession` call. The class-level
    // SessionState (cap detection, model-error capture, per-session
    // usage accumulation) lands in 7A.4 alongside StubHost parity;
    // for now the session is spawned without that bookkeeping so
    // the seam wiring is the only thing this test exercises.
    const roleConfig = this.lookupRoleConfig(role);
    const modelIndex = opts.modelIndex ?? 0;

    // 1. Resolve the model. `selectModelEntry` returns null for the
    //    system-model path (no `models` field on the role); the SDK
    //    then uses its own default model. `resolveModel` throws
    //    `MalformedModelEntryError` / `ModelNotFoundError` on
    //    malformed / missing entries.
    const entry = selectModelEntry(role, roleConfig, modelIndex);
    let model: Model<never> | undefined;
    let logical: string | null = null;
    if (entry !== null) {
      const resolved = resolveModel(role, entry, this.modelRegistry);
      model = resolved.model;
      logical = resolved.logical;
    }

    // 2. Load the role's system prompt. `loadSystemPrompt` returns
    //    null when the role has no `system_prompt` field; the
    //    `systemPromptOverride` then leaves the SDK default in
    //    place.
    const rolePrompt = await loadSystemPrompt(role, roleConfig?.system_prompt, this.cwd);

    // 3. Build the `DefaultResourceLoader` with the role's prompt
    //    wired via `systemPromptOverride`. The override is a closure
    //    over `rolePrompt` so a single loader instance re-evaluates
    //    the same string each time the SDK calls
    //    `loader.getSystemPrompt()`. `await loader.reload()` is
    //    required by the SDK before the session uses the loader.
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      systemPromptOverride: () => rolePrompt ?? undefined,
    });
    await loader.reload();

    // 4. Build the tools allowlist. The `tools` option on
    //    `createAgentSession` is the SDK's allowlist — forgetting
    //    to name `handoff` / `end` here silently disables them
    //    even when they're in `customTools` (sdk-surface.md §1).
    //    `buildToolsAllowlist` dedups so a role that already names
    //    them in `role.tools` still gets them exactly once.
    const roleTools = roleConfig?.tools;
    const tools = buildToolsAllowlist(roleTools);

    // 5. Build the file-backed `SessionManager` rooted under the
    //    conductor's per-run directory (NOT pi's own session tree).
    //    `SessionManager.create(cwd, sessionDir)` puts each session's
    //    JSONL file directly in `sessionDir`. The constructor
    //    `mkdirSync`'d `sessionDir` already, so this never ENOENTs.
    const sessionManager = SessionManager.create(this.cwd, this.sessionDir);

    // 6. Build the per-session seam + the handoff/end tools. The
    //    seam's capture buffer is the loop's read surface (§12.1);
    //    the tools write to it on call.
    const seam = new SessionSeam();
    const handoff = createHandoffTool(seam);
    const end = createEndTool(seam);

    // 7. Spawn the real `AgentSession` via the SDK. `model` is
    //    `undefined` for the system-model path; the SDK uses its
    //    default in that case (no `model` override).
    const createOpts: Parameters<typeof createAgentSession>[0] = {
      cwd: this.cwd,
      modelRegistry: this.modelRegistry,
      resourceLoader: loader,
      sessionManager,
      customTools: [handoff, end],
      tools: [...tools],
    };
    if (model !== undefined) {
      // The SDK's `model` is `Model<any>`; `resolveModel` returns
      // `Model<never>` (any-Api escape, see the function's
      // comment). Cast at the boundary; the SDK handles any-Api
      // models via its discriminated `api` field.
      (createOpts as { model?: Model<never> }).model = model;
    }
    const { session } = await createAgentSession(createOpts);

    // 8. Wrap the SDK session in the loop's `RoleSession` seam.
    //    The wrapper explicitly forwards the SDK methods the loop
    //    uses (`subscribe`, `prompt`, `dispose`) — the SDK's
    //    `AgentSession` has these on the prototype, so a spread
    //    would miss them. Two SDK fields are also exposed as
    //    extra properties: `systemPrompt` (a getter) and
    //    `getActiveToolNames` (a method). These are NOT part of
    //    the `RoleSession` interface — the loop doesn't read them
    //    — but the 7A.3 wiring tests do (via a typed cast). The
    //    spread-vs-forward choice is deliberate: forwarding keeps
    //    the wrapper small and makes the seam-only fields
    //    (`readCaptureBuffer`, `resetCaptureBuffer`) obvious.
    //    7A.4 adds the per-session `SessionState` (cap detection,
    //    usage accumulation) and event subscription; for now the
    //    session is bare, which is enough for the 7A.3 wiring
    //    tests (systemPrompt + tools + session file location).
    const wrapper = {
      role,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? `${this.sessionDir}/${session.sessionId}.jsonl`,
      model: logical,
      readCaptureBuffer: () => seam.read(),
      resetCaptureBuffer: () => seam.reset(),
      subscribe: (listener: (event: AgentSessionEvent) => void) => session.subscribe(listener),
      prompt: (text: string) => session.prompt(text),
      dispose: async () => {
        session.dispose();
      },
      // Test-introspection escape hatches. The loop never reads
      // these; the wiring tests cast through `unknown` to verify
      // the resource loader + tools allowlist are wired correctly.
      get systemPrompt(): string {
        return session.systemPrompt;
      },
      getActiveToolNames: () => session.getActiveToolNames(),
    };
    return wrapper as unknown as RoleSession;
  }

  /**
   * Look up the role's `RoleConfig` from the loaded manifest.
   * Returns `undefined` for an undeclared role (which the loop
   * shouldn't ask for; surfaced as a "use system model" fallback
   * downstream, matching `StubHost`'s tolerance). Internal helper.
   */
  private lookupRoleConfig(role: Role): RoleConfig | undefined {
    return this.loadedManifest.manifest.roles.find((r) => r.name === role);
  }

  captureUsage(_session: RoleSession): UsageRecord {
    throw new Error("ProductionHost.captureUsage: not yet implemented (Phase 7A.4)");
  }

  persistRecord(_record: PersistedRecord): void {
    throw new Error("ProductionHost.persistRecord: not yet implemented (Phase 7A.4)");
  }

  seedRunMemory(_args: {
    readonly checkpoint: import("../core/types.js").Checkpoint;
    readonly def: import("../core/types.js").MachineDefinition;
    readonly goal: string;
    readonly runCostCap: number | null;
  }): RunMemory {
    throw new Error("ProductionHost.seedRunMemory: not yet implemented (Phase 7A.4)");
  }

  async abortSession(_session: RoleSession, _reason: string): Promise<void> {
    throw new Error("ProductionHost.abortSession: not yet implemented (Phase 7A.4)");
  }

  sealSession(_session: RoleSession): void {
    throw new Error("ProductionHost.sealSession: not yet implemented (Phase 7A.4)");
  }

  nextVisitIndex(_role: Role): number {
    throw new Error("ProductionHost.nextVisitIndex: not yet implemented (Phase 7A.4)");
  }

  sessionTerminalReason(_session: RoleSession): SessionTerminalReason {
    throw new Error("ProductionHost.sessionTerminalReason: not yet implemented (Phase 7A.4)");
  }

  getNextModel(_role: Role, _currentModelIndex: number): string | null {
    throw new Error("ProductionHost.getNextModel: not yet implemented (Phase 7A.4)");
  }

  runCostSoFar(): number {
    throw new Error("ProductionHost.runCostSoFar: not yet implemented (Phase 7A.4)");
  }
}
