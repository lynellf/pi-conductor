/** Per-run configuration for the isolated role machine-tools extension. */

import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { Role } from "../../core/types.js";

/** Environment variable naming the mandatory machine-tools configuration file. */
export const MACHINE_TOOLS_CONFIG_ENV = "PI_CONDUCTOR_MACHINE_TOOLS_CONFIG";

/** TypeBox shape serialized by the host for one isolated role process. */
export const machineToolsConfigSchema = Type.Object(
  {
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
    requestFilesBridge: Type.Optional(
      Type.Object(
        {
          directory: Type.String({ minLength: 1 }),
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
  /** Explicitly provision the host-owned bridge directory required for `request_files`. */
  readonly enableRequestFilesBridge?: boolean;
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
  const config: MachineToolsConfig = {
    workspaceRoot,
    mounts,
    declaredToolNames: [...options.declaredToolNames],
    ...(options.enableDelegateBridge === true && bridgeDirectory !== undefined
      ? { delegateBridge: { directory: bridgeDirectory } }
      : {}),
    ...(options.enableRequestFilesBridge === true && bridgeDirectory !== undefined
      ? { requestFilesBridge: { directory: bridgeDirectory } }
      : {}),
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
