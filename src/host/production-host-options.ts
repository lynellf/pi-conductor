/** Public constructor contract for the SDK-backed ProductionHost. */
import type { ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RecordLog } from "../persistence/log.js";
import type { DisplaySink } from "./display-sink.js";
import type { LoadedManifest } from "./manifest.js";
import type { RoleTurnTelemetryOptions } from "./role-turn-producer.js";
import type { NodeRoleSession } from "./rpc/node-role-session.js";
import type { NodeRoleSessionOptions } from "./rpc/protocol.js";
/**
 * Constructor options for `ProductionHost`. Mirrors the production
 * context the orchestration loop needs to pass through: the
 * `ModelRegistry` (typically the extension's
 * `ExtensionCommandContext.modelRegistry`, shared with pi's
 * configured providers), the working directory (typically
 * `ctx.cwd`), and the run-scoped state (`log`, `loadedManifest`,
 * `runId`) the loop already gives `StubHost`.
 */
/** Construction dependencies for a production Host run. */
export interface ProductionHostOptions {
  /** Real `ModelRegistry` from the host's environment (extension
   *  `ExtensionCommandContext.modelRegistry` or
   *  `ModelRegistry.create(authStorage, modelsPath)` in standalone). */
  readonly modelRegistry: ModelRegistry;
  /** Working directory for prompt-path resolution and session cwd. */
  readonly cwd: string;
  /** Optional extension UI handle threaded into role sessions. */
  readonly uiContext?: ExtensionUIContext;
  /**
   * Live guard for the captured UI context. When an extension session is
   * replaced, role startup must skip binding the stale context (issue #44).
   * Non-extension callers omit this and retain the normal binding behavior.
   */
  readonly isUiContextCurrent?: () => boolean;
  /** Optional display sink for streamed role output. */
  readonly displaySink?: DisplaySink;
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
   * `<cwd>/.pi-conductor/agent`. An explicit value also configures an
   * isolated RPC child; otherwise isolated children use Pi's configured
   * agent directory so roles without `models:` retain Pi defaults.
   */
  readonly agentDir?: string;
  /** Test seam for the otherwise direct isolated Node RPC role-session constructor. */
  readonly nodeRoleSessionFactory?: (options: NodeRoleSessionOptions) => Promise<NodeRoleSession>;
  /**
   * Issue #68: bounded role-turn telemetry options for the run-owned producer.
   * Enabled by default; a partial `limits` overlays the v1 defaults before the
   * host subscribes to each role session.
   */
  readonly roleTurnTelemetry?: RoleTurnTelemetryOptions;
}
