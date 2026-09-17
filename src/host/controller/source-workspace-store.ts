/** Atomic private storage and byte-level verification for source workspaces — issue #118. */

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type { ControllerOutputPrincipal } from "../../manifest/controller-output.js";
import {
  assertSourceWorkspaceRecord,
  type SourceWorkspaceContent,
  type SourceWorkspaceIntent,
  sourceWorkspaceIntentDigest,
  sourceWorkspacePrincipalKey,
} from "../../persistence/source-workspace.js";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import { canonicalPrivateRoot } from "./git-effect-operations.js";
import type {
  PreparedSourceWorkspace,
  SourceWorkspaceGrant,
  SourceWorkspacePatchLineage,
} from "./source-workspace-contract.js";
import { SourceWorkspaceError } from "./source-workspace-contract.js";
import { gitText, runSourceGit } from "./source-workspace-git.js";
import { verifySourcePatchLineage } from "./source-workspace-validation.js";

const refPattern = /^source-workspace\/v1\/([a-f0-9]{64})\/([a-f0-9]{64})$/u;

interface StoredManifest {
  readonly ref: string;
  readonly manifest_sha256: string;
  readonly intent: SourceWorkspaceIntent;
  readonly content: SourceWorkspaceContent;
  readonly git_inventory_digest: string;
}

/** Private immutable storage for source materializations. */
export class SourceWorkspaceStore {
  readonly #root: string;
  readonly #staging: string;
  readonly #published: string;

  private constructor(root: string) {
    this.#root = root;
    this.#staging = join(root, "staging");
    this.#published = join(root, "published");
  }

  /** Open a canonical host-owned source-workspace root. */
  static async open(options: { readonly root: string }): Promise<SourceWorkspaceStore> {
    try {
      await mkdir(options.root, { recursive: true, mode: 0o700 });
      const root = await canonicalPrivateRoot(options.root);
      for (const child of ["staging", "published", "quarantine"]) {
        await mkdir(join(root, child), { recursive: true, mode: 0o700 });
        await chmod(join(root, child), 0o700);
      }
      return new SourceWorkspaceStore(root);
    } catch (cause) {
      throw new SourceWorkspaceError("storage-failure", "unsafe source workspace root", { cause });
    }
  }

  /** Allocate a private temporary directory that callers must quarantine after use. */
  async createWorkingDirectory(workspaceId: string): Promise<string> {
    return mkdtemp(join(this.#staging, `${workspaceId}-work-`));
  }

  /** Move already-verified source and Git directories into an atomically visible sealed workspace. */
  async publish(
    intent: SourceWorkspaceIntent,
    sourcePath: string,
    gitPath: string,
    content: SourceWorkspaceContent,
  ): Promise<PreparedSourceWorkspace> {
    const intentDigest = sourceWorkspaceIntentDigest(intent);
    const stage = await mkdtemp(join(this.#staging, `${intent.workspace_id}-publish-`));
    try {
      await rename(sourcePath, join(stage, "source"));
      await rename(gitPath, join(stage, "git"));
      await seal(join(stage, "source"));
      await seal(join(stage, "git"));
      const gitInventoryDigest = await sealedTreeDigest(join(stage, "git"));
      const manifestHash = sha256Canonical({
        intent_digest: intentDigest,
        content,
        git_inventory_digest: gitInventoryDigest,
      });
      const ref = `source-workspace/v1/${intent.workspace_id}/${manifestHash}`;
      const destination = join(this.#published, intent.workspace_id, manifestHash);
      const manifest: StoredManifest = {
        ref,
        manifest_sha256: manifestHash,
        intent,
        content,
        git_inventory_digest: gitInventoryDigest,
      };
      await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest)}\n`, {
        mode: 0o400,
        flag: "wx",
      });
      await seal(stage);
      // The staging root itself must remain traversable/movable until its one atomic rename.
      await chmod(stage, 0o700);
      await mkdir(join(this.#published, intent.workspace_id), { recursive: true, mode: 0o700 });
      try {
        await lstat(destination);
        await this.quarantine(stage);
        return this.read(ref, undefined, true);
      } catch (cause) {
        if (!missing(cause)) throw cause;
      }
      await rename(stage, destination);
      await chmod(destination, 0o500);
      return this.read(ref, undefined, true);
    } catch (cause) {
      await this.quarantine(stage);
      if (cause instanceof SourceWorkspaceError) throw cause;
      throw new SourceWorkspaceError("storage-failure", "source workspace publication failed", {
        cause,
      });
    }
  }

  /** Verify and open a descriptor; optional Git access remains host-controlled. */
  async read(
    ref: string,
    principal: ControllerOutputPrincipal | undefined,
    _includeGit: boolean,
    grant?: SourceWorkspaceGrant,
  ): Promise<PreparedSourceWorkspace> {
    const match = refPattern.exec(ref);
    if (match?.[1] === undefined || match[2] === undefined)
      throw new SourceWorkspaceError("workspace-missing");
    const [workspaceId, hash] = [match[1], match[2]];
    const root = join(this.#published, workspaceId, hash);
    try {
      const manifest = await readManifest(join(root, "manifest.json"));
      if (
        manifest.ref !== ref ||
        manifest.manifest_sha256 !== hash ||
        manifest.intent.workspace_id !== workspaceId ||
        sha256Canonical({
          intent_digest: sourceWorkspaceIntentDigest(manifest.intent),
          content: manifest.content,
          git_inventory_digest: manifest.git_inventory_digest,
        }) !== hash
      )
        throw new SourceWorkspaceError("workspace-corrupt");
      assertSourceWorkspaceRecord(manifest.intent);
      verifySourcePatchLineage(manifest.content.patches, manifest.content.patches_digest);
      if (sha256Canonical(manifest.content.patches) !== sha256Canonical(manifest.intent.patches))
        throw new SourceWorkspaceError(
          "workspace-corrupt",
          "source patch lineage differs from intent",
        );
      if (
        grant !== undefined &&
        !sameStrings(manifest.content.allowed_paths, [...grant.allowedPaths].sort())
      )
        throw new SourceWorkspaceError("grant-revoked", "source allowed paths changed");
      if (grant !== undefined && !intentMatchesGrant(manifest.intent, grant))
        throw new SourceWorkspaceError(
          "grant-revoked",
          "workspace intent is outside current grant",
        );
      if (
        principal !== undefined &&
        !manifest.intent.audience.some(
          (item) => sourceWorkspacePrincipalKey(item) === sourceWorkspacePrincipalKey(principal),
        )
      )
        throw new SourceWorkspaceError("consumer-denied");
      const sourcePath = join(root, "source");
      const gitPath = join(root, "git");
      await verifySource(sourcePath, manifest.content);
      await verifyGit(gitPath, manifest.content, manifest.git_inventory_digest);
      return Object.freeze({
        ref,
        sourcePath,
        checkoutPath: gitPath,
        baseCommit: manifest.intent.resolved_base,
        headCommit: manifest.content.head_commit,
        treeId: manifest.content.tree_id,
        inventoryDigest: manifest.content.inventory_digest,
        fileCount: manifest.content.file_count,
        byteLength: manifest.content.byte_length,
        policyDigest: manifest.intent.policy_digest,
        audience: Object.freeze([...manifest.intent.audience]),
        repositoryRef: manifest.intent.requested_ref,
        repositoryFingerprint: manifest.intent.repository_fingerprint,
        allowedPaths: Object.freeze([...manifest.content.allowed_paths]),
        patches: Object.freeze(manifest.content.patches.map(lineageOf)),
        patchesDigest: manifest.content.patches_digest,
      });
    } catch (cause) {
      if (cause instanceof SourceWorkspaceError) throw cause;
      if (missing(cause)) throw new SourceWorkspaceError("workspace-missing");
      throw new SourceWorkspaceError("workspace-corrupt", "sealed source verification failed", {
        cause,
      });
    }
  }

  /** Preserve partial private state for inspection without returning it to a consumer. */
  async quarantine(path: string): Promise<void> {
    try {
      await lstat(path);
    } catch (cause) {
      if (missing(cause)) return;
      throw cause;
    }
    await rename(path, join(this.#root, "quarantine", `${basename(path)}-${randomUUID()}`));
  }
}

function intentMatchesGrant(intent: SourceWorkspaceIntent, grant: SourceWorkspaceGrant): boolean {
  return (
    intent.source_id === grant.sourceId &&
    intent.source_authority_digest === grant.authorityDigest &&
    intent.repository_fingerprint === grant.repositoryFingerprint &&
    intent.policy_digest ===
      sha256Canonical({
        source_id: grant.sourceId,
        authority_digest: grant.authorityDigest,
        repository_fingerprint: grant.repositoryFingerprint,
        allowed_refs: [...grant.allowedRefs].sort(),
        allowed_paths: [...grant.allowedPaths].sort(),
        max_files: grant.maxFiles,
        max_bytes: grant.maxBytes,
        consumers: [...grant.consumers].map(sourceWorkspacePrincipalKey).sort(),
        allow_git_view: grant.allowGitView,
      })
  );
}

/** Compute a content inventory from actual regular bytes copied into a mounted source tree. */
export async function sourceContent(
  root: string,
  limits: Pick<SourceWorkspaceGrant, "maxFiles" | "maxBytes">,
): Promise<SourceWorkspaceInventory> {
  const inventory = await inventoryOf(root, limits, false);
  return {
    inventory_digest: sha256Canonical({
      domain: "pi-conductor/source-workspace-files/v1",
      inventory: inventory.files,
    }),
    file_count: inventory.files.length,
    byte_length: inventory.bytes,
  };
}

/** Inventory subset returned before source patches and lineage are bound. */
export interface SourceWorkspaceInventory {
  readonly inventory_digest: string;
  readonly file_count: number;
  readonly byte_length: number;
}

async function verifySource(root: string, content: SourceWorkspaceContent): Promise<void> {
  let inventory: Awaited<ReturnType<typeof inventoryOf>>;
  try {
    inventory = await inventoryOf(
      root,
      {
        maxFiles: content.file_count,
        maxBytes: content.byte_length,
      },
      true,
    );
  } catch (cause) {
    if (cause instanceof SourceWorkspaceError && cause.code === "workspace-limit-exceeded")
      throw new SourceWorkspaceError("workspace-corrupt", "sealed source contains extra bytes", {
        cause,
      });
    throw cause;
  }
  if (
    inventory.files.length !== content.file_count ||
    inventory.bytes !== content.byte_length ||
    sha256Canonical({
      domain: "pi-conductor/source-workspace-files/v1",
      inventory: inventory.files,
    }) !== content.inventory_digest
  )
    throw new SourceWorkspaceError(
      "workspace-corrupt",
      "source bytes differ from sealed inventory",
    );
}

async function inventoryOf(
  root: string,
  limits: { readonly maxFiles: number; readonly maxBytes: number },
  sealed: boolean,
) {
  const files: { path: string; executable: boolean; sha256: string; byte_length: number }[] = [];
  let bytes = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (sealed && (stat.mode & 0o777) !== 0o500))
      throw new SourceWorkspaceError("workspace-corrupt");
    for (const name of (await readdir(directory)).sort()) {
      if (name === ".git")
        throw new SourceWorkspaceError(
          "workspace-corrupt",
          "source tree contains Git control data",
        );
      const path = join(directory, name);
      const item = await lstat(path);
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      if (item.isDirectory()) await visit(path, relativePath);
      else if (
        item.isFile() &&
        !item.isSymbolicLink() &&
        item.nlink === 1 &&
        (!sealed || (item.mode & 0o777) === 0o400 || (item.mode & 0o777) === 0o500)
      ) {
        const data = await readFile(path);
        bytes += data.length;
        files.push({
          path: relativePath,
          executable: (item.mode & 0o111) !== 0,
          sha256: createHash("sha256").update(data).digest("hex"),
          byte_length: data.length,
        });
        if (files.length > limits.maxFiles || bytes > limits.maxBytes)
          throw new SourceWorkspaceError("workspace-limit-exceeded");
      } else
        throw new SourceWorkspaceError("workspace-corrupt", "source tree has a non-regular entry");
    }
  }
  await visit(root, "");
  return { files, bytes };
}

async function verifyGit(
  root: string,
  content: SourceWorkspaceContent,
  expectedInventoryDigest: string,
): Promise<void> {
  if ((await sealedTreeDigest(root)) !== expectedInventoryDigest)
    throw new SourceWorkspaceError("workspace-corrupt", "Git view controls changed");
  if (gitText(await runSourceGit(root, ["rev-parse", "HEAD"])) !== content.head_commit)
    throw new SourceWorkspaceError("workspace-corrupt", "Git view head changed");
  if (gitText(await runSourceGit(root, ["rev-parse", "HEAD^{tree}"])) !== content.tree_id)
    throw new SourceWorkspaceError("workspace-corrupt", "Git view tree changed");
  const status = gitText(
    await runSourceGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
  );
  if (status !== "")
    throw new SourceWorkspaceError("workspace-corrupt", "Git view has changed or untracked files");
}

async function sealedTreeDigest(root: string): Promise<string> {
  const files: { path: string; mode: number; sha256: string }[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o500)
      throw new SourceWorkspaceError("workspace-corrupt", "Git view has unsafe directory");
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const item = await lstat(path);
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      if (item.isDirectory()) await visit(path, relativePath);
      else if (
        item.isFile() &&
        !item.isSymbolicLink() &&
        item.nlink === 1 &&
        ((item.mode & 0o777) === 0o400 || (item.mode & 0o777) === 0o500)
      ) {
        files.push({
          path: relativePath,
          mode: item.mode & 0o777,
          sha256: createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        });
      } else throw new SourceWorkspaceError("workspace-corrupt", "Git view has unsafe entry");
    }
  }
  await visit(root, "");
  return sha256Canonical({ domain: "pi-conductor/source-workspace-git-controls/v1", files });
}

async function seal(root: string): Promise<void> {
  const stat = await lstat(root);
  if (stat.isDirectory()) {
    for (const name of await readdir(root)) await seal(join(root, name));
    await chmod(root, 0o500);
  } else if (stat.isFile()) await chmod(root, (stat.mode & 0o111) === 0 ? 0o400 : 0o500);
  else throw new SourceWorkspaceError("storage-failure", "cannot seal special source entry");
}

async function readManifest(path: string): Promise<StoredManifest> {
  return JSON.parse(await readFile(path, "utf8")) as StoredManifest;
}

function missing(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function lineageOf(patch: SourceWorkspaceIntent["patches"][number]): SourceWorkspacePatchLineage {
  return Object.freeze({
    ref: patch.ref,
    sha256: patch.sha256,
    byteLength: patch.byte_length,
    acceptedBase: patch.accepted_base,
    allowedPaths: Object.freeze([...patch.allowed_paths]),
  });
}
