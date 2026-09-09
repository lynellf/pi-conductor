/** Shared run-scoped state and SDK setup for the production host. */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RecordLog, SnapshotPinnedRecord } from "../persistence/log.js";
import type { SessionState } from "./cost.js";
import type { DisplaySink } from "./display-sink.js";
import { EndGuardRunner } from "./end-guard-runner.js";
import { assertFileToolWorkerRuntime } from "./execution/file-tool-worker.js";
import { isSupervisedProcessSupported } from "./execution/supervised-process.js";
import type { LoadedManifest } from "./manifest.js";
import type { ProductionHostOptions } from "./production-host-options.js";
import { ProductionSessionState } from "./production-session-state.js";
import { RoleTurnProducer } from "./role-turn-producer.js";
import type { NodeRoleSession } from "./rpc/node-role-session.js";
import { createNodeRoleSession } from "./rpc/node-role-session-factory.js";
import type { NodeRoleSessionOptions } from "./rpc/protocol.js";
import type { SessionEventSource } from "./session-event-handler.js";
import { assertTrajectorySdkSupportedForHandoffs } from "./trajectory-sdk-capability.js";

/** Shared run-scoped SDK state used by the production Host facade. */
export class ProductionHostContext {
  readonly modelRegistry: ModelRegistry;
  readonly cwd: string;
  readonly log: RecordLog;
  readonly loadedManifest: LoadedManifest;
  readonly runId: string;
  readonly uiContext: ExtensionUIContext | undefined;
  readonly isUiContextCurrent: (() => boolean) | undefined;
  readonly displaySink: DisplaySink | undefined;
  readonly sessionDir: string;
  readonly agentDir: string;
  readonly isolatedAgentDir: string;
  protected readonly roleTurnProducer: RoleTurnProducer;
  protected readonly nodeRoleSessionFactory: (
    options: NodeRoleSessionOptions,
  ) => Promise<NodeRoleSession>;
  protected readonly endGuardRunner: EndGuardRunner;
  // Keep per-session state beside the live SDK session map so Host methods can
  // observe usage and terminal state without making extracted helpers owners.
  protected readonly sessionStates: Map<string, SessionState> = new Map();
  protected readonly agentsBySessionId: Map<string, SessionEventSource> = new Map();
  protected readonly sessionState: ProductionSessionState;
  protected snapshotPin: Promise<SnapshotPinnedRecord> | null = null;

  constructor(opts: ProductionHostOptions) {
    // Fail before the orchestration loop admits a role session. The worker
    // cannot recover from a host/package mismatch by retrying a model.
    const usesSupervisedFileTools = opts.loadedManifest.manifest.roles.some(
      (role) =>
        role.tools?.some((tool) =>
          ["read", "write", "edit", "ls", "find", "grep"].includes(tool),
        ) === true || role.delegation !== undefined,
    );
    if (usesSupervisedFileTools) {
      assertFileToolWorkerRuntime();
    }
    assertTrajectorySdkSupportedForHandoffs(opts.loadedManifest.manifest.handoffs);
    this.modelRegistry = opts.modelRegistry;
    this.cwd = resolve(opts.cwd);
    this.log = opts.log;
    this.loadedManifest = opts.loadedManifest;
    this.runId = opts.runId;
    this.uiContext = opts.uiContext;
    this.isUiContextCurrent = opts.isUiContextCurrent;
    this.displaySink = opts.displaySink;
    this.sessionDir =
      opts.sessionDir === undefined
        ? join(this.cwd, ".pi-conductor", "runs", opts.runId, "sessions")
        : resolve(opts.sessionDir);
    this.agentDir =
      opts.agentDir === undefined
        ? join(this.cwd, ".pi-conductor", "agent")
        : resolve(opts.agentDir);
    this.isolatedAgentDir = opts.agentDir === undefined ? resolve(getAgentDir()) : this.agentDir;
    this.roleTurnProducer = new RoleTurnProducer({
      runId: this.runId,
      log: this.log,
      telemetry: opts.roleTurnTelemetry,
    });
    this.nodeRoleSessionFactory = opts.nodeRoleSessionFactory ?? createNodeRoleSession;
    if (this.loadedManifest.manifest.end_guard !== undefined && !isSupervisedProcessSupported()) {
      throw new Error("end_guard requires a platform with supervised process cleanup");
    }
    this.endGuardRunner = new EndGuardRunner(this.cwd);
    this.sessionState = new ProductionSessionState(this.sessionStates, this.agentsBySessionId);
    // SessionManager writes JSONL directly and does not create its parent.
    mkdirSync(this.sessionDir, { recursive: true });
  }
}
