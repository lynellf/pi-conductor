/** Per-run configuration for the isolated role machine-tools extension. */

import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { Role } from "../../core/types.js";
import type { DelegationInterface, DelegationMode } from "../../manifest/types.js";
import type { ReviewGateOptions } from "../review.js";

/** Environment variable naming the mandatory machine-tools configuration file. */
export const MACHINE_TOOLS_CONFIG_ENV = "PI_CONDUCTOR_MACHINE_TOOLS_CONFIG";

/** TypeBox shape serialized by the host for one isolated role process. */
export const machineToolsConfigSchema = Type.Object(
  {
    role: Type.Optional(Type.String({ minLength: 1 })),
    orchestratorRole: Type.Optional(Type.String({ minLength: 1 })),
    controlProtocol: Type.Optional(Type.Union([Type.Literal("v1"), Type.Literal("v2")])),
    workspaceRoot: Type.String({ minLength: 1 }),
    mounts: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          writable: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    declaredToolNames: Type.Array(Type.String({ minLength: 1 })),
    delegateBridge: Type.Optional(
      Type.Object(
        {
          directory: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    delegationInterface: Type.Optional(
      Type.Union([Type.Literal("assignments_v1"), Type.Literal("legacy_v1")]),
    ),
    delegationMode: Type.Optional(
      Type.Union([Type.Literal("blocking"), Type.Literal("nonblocking")]),
    ),
    legacyDelegationMode: Type.Optional(Type.Boolean()),
    requestFilesBridge: Type.Optional(
      Type.Object(
        {
          directory: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    executionBridge: Type.Optional(
      Type.Object(
        {
          directory: Type.String({ minLength: 1 }),
          timeout_ms: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
        },
        { additionalProperties: false },
      ),
    ),
    reviewGate: Type.Optional(
      Type.Object(
        {
          phase_id: Type.String({ minLength: 1, maxLength: 256 }),
          gate_id: Type.String({ minLength: 1, maxLength: 256 }),
          phase_owner_role: Type.String({ minLength: 1, maxLength: 256 }),
          reviewed_revision: Type.String({ minLength: 1, maxLength: 256 }),
          next_phase: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          repair_guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** Serialized data required to construct the isolated role's confined tool surface. */
export type MachineToolsConfig = Static<typeof machineToolsConfigSchema>;

/** Typed error for a missing, malformed, or unusable machine-tools configuration. */
export class MachineToolsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineToolsConfigError";
  }
}

/** Host-owned inputs for one isolated role's static machine-tools configuration. */
export interface WriteMachineToolsConfigOptions {
  /** Host-owned run session directory, outside every role tool projection. */
  readonly sessionDir: string;
  /** The role and visit make the final path deterministic within the run. */
  readonly role: Role;
  /** Pinned orchestrator role used by the v2 RPC handoff schema. */
  readonly orchestratorRole?: Role;
  /** Pinned role-control protocol for this run. */
  readonly controlProtocol?: "v1" | "v2";
  /** The role's 1-based visit index. */
  readonly visitIndex: number;
  /** Actual provisioned workspace root, never synthesized from cwd or a commit. */
  readonly workspaceRoot: string;
  /** Actual projection mounts from the already-computed guarantee. */
  readonly mounts: readonly { readonly path: string; readonly writable: boolean }[];
  /** Declared confined file-tool names from the already-computed projection. */
  readonly declaredToolNames: readonly string[];
  /** Explicitly provision the host-owned bridge directory required for `delegate`. */
  readonly enableDelegateBridge?: boolean;
  /** Trusted model-visible protocol for this role's delegation policy. */
  readonly delegationInterface?: DelegationInterface;
  /** Trusted effective mode for this role's delegation policy. */
  readonly delegationMode?: DelegationMode;
  /** Explicit durable provenance for pre-mode snapshots. */
  readonly legacyDelegationMode?: boolean;
  /** Explicitly provision the host-owned bridge directory required for `request_files`. */
  readonly enableRequestFilesBridge?: boolean;
  /** Explicitly provision the host-owned bridge directory for executable file tools. */
  readonly enableExecutionBridge?: boolean;
  /** Bounded bridge wait covering execution plus host cleanup. */
  readonly executionBridgeTimeoutMs?: number;
  /** Serialized host-pinned reviewer gate for isolated roles. */
  readonly reviewGate?: ReviewGateOptions;
}

/** Atomically write one isolated role's static machine-tools configuration under the host run state. */
export async function writeMachineToolsConfig(
  options: WriteMachineToolsConfigOptions,
): Promise<string> {
  if (!Number.isSafeInteger(options.visitIndex) || options.visitIndex < 1) {
    throw new MachineToolsConfigError(
      "machine-tools configuration visitIndex must be a positive integer",
    );
  }
  const workspaceRoot = options.workspaceRoot;
  const mounts = options.mounts.map((mount) => ({ path: mount.path, writable: mount.writable }));
  requireAbsoluteProjectionPath(workspaceRoot, "workspaceRoot");
  for (const mount of mounts) requireAbsoluteProjectionPath(mount.path, "mount path");

  const configuredDirectory = resolve(options.sessionDir, "machine-tools");
  await mkdir(configuredDirectory, { recursive: true, mode: 0o700 });
  await chmod(configuredDirectory, 0o700);
  const configDir = realpathSync(configuredDirectory);
  const roleFilename = encodeRoleFilename(options.role);
  const bridgeDirectory =
    options.enableDelegateBridge === true || options.enableRequestFilesBridge === true
      ? await createDelegateBridgeDirectory(configDir, roleFilename, options.visitIndex)
      : undefined;
  const executionBridgeDirectory = options.enableExecutionBridge
    ? await createExecutionBridgeDirectory(configDir, roleFilename, options.visitIndex)
    : undefined;
  if (options.enableExecutionBridge && !isTimerDelay(options.executionBridgeTimeoutMs)) {
    throw new MachineToolsConfigError("execution bridge timeout must fit a Node timer");
  }
  const reviewGate =
    options.reviewGate !== undefined && options.role === options.reviewGate.reviewerRole
      ? options.reviewGate
      : undefined;
  const config: MachineToolsConfig = {
    ...(options.controlProtocol === "v2" &&
    options.role !== undefined &&
    options.orchestratorRole !== undefined
      ? {
          role: options.role,
          orchestratorRole: options.orchestratorRole,
          controlProtocol: "v2" as const,
        }
      : {}),
    workspaceRoot,
    mounts,
    declaredToolNames: [...options.declaredToolNames],
    ...(options.enableDelegateBridge === true && bridgeDirectory !== undefined
      ? { delegateBridge: { directory: bridgeDirectory } }
      : {}),
    ...(options.delegationInterface === undefined
      ? {}
      : { delegationInterface: options.delegationInterface }),
    ...(options.delegationMode === undefined ? {} : { delegationMode: options.delegationMode }),
    ...(options.legacyDelegationMode === undefined
      ? {}
      : { legacyDelegationMode: options.legacyDelegationMode }),
    ...(options.enableRequestFilesBridge === true && bridgeDirectory !== undefined
      ? { requestFilesBridge: { directory: bridgeDirectory } }
      : {}),
    ...(executionBridgeDirectory === undefined
      ? {}
      : {
          executionBridge: {
            directory: executionBridgeDirectory,
            timeout_ms: options.executionBridgeTimeoutMs as number,
          },
        }),
    ...(reviewGate === undefined
      ? {}
      : {
          reviewGate: {
            phase_id: reviewGate.phaseId,
            gate_id: reviewGate.gateId,
            phase_owner_role: reviewGate.phaseOwnerRole,
            reviewed_revision: reviewGate.reviewedRevision,
            ...(reviewGate.nextPhase === undefined ? {} : { next_phase: reviewGate.nextPhase }),
            ...(reviewGate.repairGuidance === undefined
              ? {}
              : { repair_guidance: reviewGate.repairGuidance }),
          },
        }),
  };
  if (!Value.Check(machineToolsConfigSchema, config)) {
    throw new MachineToolsConfigError("machine-tools configuration has an invalid structure");
  }
  const configPath = childPath(configDir, `${roleFilename}-v${options.visitIndex}.json`);
  const temporaryPath = childPath(
    configDir,
    `.${roleFilename}-v${options.visitIndex}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return configPath;
}

/** Load and validate the mandatory, host-written configuration for an RPC role process. */
export function loadMachineToolsConfig(env: NodeJS.ProcessEnv = process.env): MachineToolsConfig {
  const configPath = env[MACHINE_TOOLS_CONFIG_ENV];
  if (typeof configPath !== "string" || configPath.trim().length === 0) {
    throw new MachineToolsConfigError(`${MACHINE_TOOLS_CONFIG_ENV} must name a configuration file`);
  }
  if (!isAbsolute(configPath)) {
    throw new MachineToolsConfigError(
      `${MACHINE_TOOLS_CONFIG_ENV} must name an absolute file path`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new MachineToolsConfigError("machine-tools configuration could not be read as JSON");
  }
  if (!Value.Check(machineToolsConfigSchema, parsed)) {
    throw new MachineToolsConfigError("machine-tools configuration has an invalid structure");
  }

  return Object.freeze({
    ...(parsed.role === undefined ? {} : { role: parsed.role }),
    ...(parsed.orchestratorRole === undefined ? {} : { orchestratorRole: parsed.orchestratorRole }),
    ...(parsed.controlProtocol === undefined ? {} : { controlProtocol: parsed.controlProtocol }),
    workspaceRoot: requireDirectory(parsed.workspaceRoot, "workspaceRoot"),
    mounts: Object.freeze(
      parsed.mounts.map((mount) =>
        Object.freeze({
          path: requireDirectory(mount.path, "mount path"),
          writable: mount.writable,
        }),
      ),
    ),
    declaredToolNames: Object.freeze([...parsed.declaredToolNames]),
    ...(parsed.delegateBridge === undefined
      ? {}
      : {
          delegateBridge: Object.freeze({
            directory: requireDirectory(
              parsed.delegateBridge.directory,
              "delegate bridge directory",
            ),
          }),
        }),
    ...(parsed.delegationInterface === undefined
      ? {}
      : { delegationInterface: parsed.delegationInterface }),
    ...(parsed.delegationMode === undefined ? {} : { delegationMode: parsed.delegationMode }),
    ...(parsed.legacyDelegationMode === undefined
      ? {}
      : { legacyDelegationMode: parsed.legacyDelegationMode }),
    ...(parsed.requestFilesBridge === undefined
      ? {}
      : {
          requestFilesBridge: Object.freeze({
            directory: requireDirectory(
              parsed.requestFilesBridge.directory,
              "request_files bridge directory",
            ),
          }),
        }),
    ...(parsed.executionBridge === undefined
      ? {}
      : {
          executionBridge: Object.freeze({
            directory: requireDirectory(
              parsed.executionBridge.directory,
              "execution bridge directory",
            ),
            timeout_ms: parsed.executionBridge.timeout_ms,
          }),
        }),
    ...(parsed.reviewGate === undefined
      ? {}
      : {
          reviewGate: Object.freeze({
            phase_id: parsed.reviewGate.phase_id,
            gate_id: parsed.reviewGate.gate_id,
            phase_owner_role: parsed.reviewGate.phase_owner_role,
            reviewed_revision: parsed.reviewGate.reviewed_revision,
            ...(parsed.reviewGate.next_phase === undefined
              ? {}
              : { next_phase: parsed.reviewGate.next_phase }),
            ...(parsed.reviewGate.repair_guidance === undefined
              ? {}
              : { repair_guidance: parsed.reviewGate.repair_guidance }),
          }),
        }),
  }) as MachineToolsConfig;
}

async function createDelegateBridgeDirectory(
  configDir: string,
  roleFilename: string,
  visitIndex: number,
): Promise<string> {
  const bridgeRoot = childPath(configDir, "delegate-bridge");
  await mkdir(bridgeRoot, { recursive: true, mode: 0o700 });
  await chmod(bridgeRoot, 0o700);
  const canonicalBridgeRoot = realpathSync(bridgeRoot);
  const bridgeDirectory = childPath(canonicalBridgeRoot, `${roleFilename}-v${visitIndex}`);
  await mkdir(bridgeDirectory, { recursive: true, mode: 0o700 });
  await chmod(bridgeDirectory, 0o700);
  return realpathSync(bridgeDirectory);
}

async function createExecutionBridgeDirectory(
  configDir: string,
  roleFilename: string,
  visitIndex: number,
): Promise<string> {
  const bridgeRoot = childPath(configDir, "execution-bridge");
  await mkdir(bridgeRoot, { recursive: true, mode: 0o700 });
  await chmod(bridgeRoot, 0o700);
  const canonicalBridgeRoot = realpathSync(bridgeRoot);
  const bridgeDirectory = childPath(
    canonicalBridgeRoot,
    `${roleFilename}-v${visitIndex}-${randomUUID()}`,
  );
  await mkdir(bridgeDirectory, { recursive: true, mode: 0o700 });
  await chmod(bridgeDirectory, 0o700);
  return realpathSync(bridgeDirectory);
}

function encodeRoleFilename(role: Role): string {
  const encoded = encodeURIComponent(role);
  if (encoded.length === 0 || encoded.includes("/") || encoded.includes("\\")) {
    throw new MachineToolsConfigError(
      "machine-tools configuration role cannot form a safe filename",
    );
  }
  return encoded;
}

function childPath(directory: string, filename: string): string {
  const candidate = join(directory, filename);
  const relativePath = relative(directory, candidate);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new MachineToolsConfigError(
      "machine-tools configuration path escapes its host-owned directory",
    );
  }
  return candidate;
}

function requireAbsoluteProjectionPath(path: string, field: string): void {
  if (!isAbsolute(path)) {
    throw new MachineToolsConfigError(`machine-tools configuration ${field} must be absolute`);
  }
}

function requireDirectory(path: string, field: string): string {
  if (!isAbsolute(path)) {
    throw new MachineToolsConfigError(`machine-tools configuration ${field} must be absolute`);
  }
  try {
    const resolved = realpathSync(path);
    if (!statSync(resolved).isDirectory()) {
      throw new MachineToolsConfigError(`machine-tools configuration ${field} must be a directory`);
    }
    return resolved;
  } catch (error) {
    if (error instanceof MachineToolsConfigError) throw error;
    throw new MachineToolsConfigError(`machine-tools configuration ${field} is unavailable`);
  }
}

function isTimerDelay(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}
