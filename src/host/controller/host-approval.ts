/** Protected operator controller authority, independent of repository requests (#115 §2). */
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, posix } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { controllerAdapterSchema } from "../../manifest/controller.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { withSandboxDirectory } from "../execution/sandbox/anchored-file-access.js";
import { canonicalTrustedSnapshotParent } from "../execution/sandbox/runtime-capture.js";

const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" });
const path = Type.String({ minLength: 1, maxLength: 4096 });
const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const runtime = Type.Object(
  {
    runtime_id: id,
    source_root: path,
    inventory_sha256: sha256,
    bootstrap_approval: Type.Object(
      {
        approvalId: id,
        files: Type.Array(Type.Object({ path, sha256 }, { additionalProperties: false }), {
          minItems: 1,
          maxItems: 10000,
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const controller = Type.Object(
  {
    controller_id: id,
    runtime_id: id,
    executable: path,
    argv: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64 }),
  },
  { additionalProperties: false },
);
const registeredSchema = Type.Object(
  {
    schema_id: id,
    schema_digest: sha256,
    schema: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

/** Versioned operator registry: runtime provenance, fixed programs and local capability grants. */
export const controllerHostApprovalSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    approval_id: id,
    runtimes: Type.Array(runtime, { minItems: 1, maxItems: 64 }),
    controllers: Type.Array(controller, { minItems: 1, maxItems: 64 }),
    adapters: Type.Array(controllerAdapterSchema, { maxItems: 64 }),
    schemas: Type.Array(registeredSchema, { maxItems: 128 }),
  },
  { additionalProperties: false },
);

/** Immutable host authority; never created from a controller response or manifest. */
export type ControllerHostApproval = Readonly<Static<typeof controllerHostApprovalSchema>>;
/** One complete approved runtime, captured before execution. */
export type ControllerRuntimeApproval = ControllerHostApproval["runtimes"][number];

const MAX_BYTES = 8 * 1024 * 1024;
const RUNTIME_ROOTS = new Set(["bin", "sbin", "usr", "lib", "lib64", "etc", "opt"]);

/** Validate registry references/digests and freeze an independent authority snapshot. */
export function validateControllerHostApproval(input: unknown): ControllerHostApproval {
  assertJsonDepth(input);
  if (!Value.Check(controllerHostApprovalSchema, input))
    throw new Error("controller host approval does not match schema version 1");
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_BYTES)
    throw new Error("controller host approval exceeds the byte limit");
  const value = structuredClone(input);
  const runtimes = unique(
    value.runtimes.map((entry) => entry.runtime_id),
    "runtime",
  );
  unique(
    value.controllers.map((entry) => entry.controller_id),
    "controller",
  );
  unique(
    value.adapters.map((entry) => entry.id),
    "adapter",
  );
  const schemas = unique(
    value.schemas.map((entry) => entry.schema_id),
    "schema",
  );
  for (const entry of value.runtimes) {
    absolute(entry.source_root);
    literal(entry.bootstrap_approval.approvalId);
    unique(
      entry.bootstrap_approval.files.map((file) => file.path),
      "runtime file",
    );
    for (const file of entry.bootstrap_approval.files) runtimePath(file.path);
    if (!entry.bootstrap_approval.files.some((file) => file.path === "bin/bash"))
      throw new Error("controller runtime approval must include bin/bash");
  }
  for (const entry of [...value.controllers, ...value.adapters]) {
    if (!runtimes.has(entry.runtime_id))
      throw new Error("controller program uses an unapproved runtime");
    absolute(entry.executable);
    runtimePath(entry.executable.slice(1));
    for (const argument of entry.argv)
      if (argument.includes("\0")) throw new Error("controller program argument contains NUL");
  }
  for (const entry of value.adapters)
    if (!schemas.has(entry.input_schema_id) || !schemas.has(entry.output_schema_id))
      throw new Error("controller adapter uses an unapproved schema");
  for (const entry of value.schemas)
    if (sha256Canonical(entry.schema) !== entry.schema_digest)
      throw new Error("controller schema digest does not match its approved definition");
  literal(value.approval_id);
  return freeze(value);
}

/** Read a private no-follow operator registry; repository files cannot impersonate host approval. */
export async function loadControllerHostApproval(
  filePath: string,
): Promise<ControllerHostApproval> {
  absolute(filePath);
  const parent = await canonicalTrustedSnapshotParent(dirname(filePath));
  privateFile(await lstat(filePath));
  const bytes = await withSandboxDirectory(parent, async (directory) => {
    const before = await directory.fileStat(basename(filePath));
    privateFile(before);
    const contents = await directory.read(basename(filePath), MAX_BYTES);
    const after = await directory.fileStat(basename(filePath));
    privateFile(after);
    if (!sameFile(before, after)) throw new Error("controller host approval changed during read");
    return contents;
  });
  if (bytes.length > MAX_BYTES) throw new Error("controller host approval exceeds the byte limit");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("controller host approval is not valid JSON");
  }
  return validateControllerHostApproval(value);
}

function privateFile(stat: Stats): void {
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !stat.isFile() ||
    stat.uid !== uid ||
    stat.nlink !== 1 ||
    (stat.mode & 0o7777) !== 0o600
  )
    throw new Error("controller host approval must be a current-user regular file with mode 600");
}
function sameFile(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.nlink === b.nlink &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function absolute(value: string): void {
  if (
    value === "/" ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.includes("\0")
  )
    throw new Error("controller authority path must be absolute and canonical");
}
function literal(value: string): void {
  if (value.length === 0 || value.trim() !== value || value.includes("\0"))
    throw new Error("controller authority identifier must be nonempty literal text");
}
function runtimePath(value: string): void {
  const parts = value.split("/");
  if (
    !RUNTIME_ROOTS.has(parts[0] ?? "") ||
    value.includes("\\") ||
    value.includes("\0") ||
    parts.some((part) => ["", ".", "..", ".git", ".pi-conductor"].includes(part))
  )
    throw new Error("controller runtime path is outside approved runtime roots");
}
function unique(values: readonly string[], label: string): ReadonlySet<string> {
  const result = new Set<string>();
  for (const value of values) {
    literal(value);
    if (result.has(value)) throw new Error(`duplicate controller ${label} identity`);
    result.add(value);
  }
  return result;
}
function assertJsonDepth(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (depth > 32) throw new Error("controller authority exceeds maximum JSON depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new Error("controller authority must contain JSON data");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("controller authority must contain plain JSON objects");
  if (ancestors.has(value)) throw new Error("controller authority contains cyclic data");
  ancestors.add(value);
  for (const child of Object.values(value)) assertJsonDepth(child, depth + 1, ancestors);
  ancestors.delete(value);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
