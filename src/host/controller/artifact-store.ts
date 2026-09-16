/** Private immutable controller artifact publication and verification — issue #115 §6. */

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { canonicalTrustedSnapshotParent } from "../execution/sandbox/runtime-capture.js";
import {
  type ArtifactBinding,
  type ArtifactControllerRangeReadRequest,
  type ArtifactManifest,
  type ArtifactRangeRead,
  type ArtifactRangeReadRequest,
  type ArtifactStaging,
  ArtifactStoreError,
  type ArtifactStoreOptions,
  artifactActionNamespace,
  artifactSha256,
  assertArtifactBinding,
  assertArtifactIdentifier,
  buildArtifactManifest,
  isNonNegativeArtifactInteger,
  isPositiveArtifactInteger,
  type PublishArtifactRequest,
  type PublishedArtifact,
  parseArtifactRef,
  publishedArtifact,
  sameArtifactBinding,
} from "./artifact-store-contract.js";
import {
  type ArtifactFileIdentity,
  assertArtifactDirectoryBeneath,
  assertImmutableArtifactDirectory,
  assertImmutableArtifactFile,
  assertPrivateArtifactDirectory,
  assertSameArtifactPayload,
  isArtifactDestinationExists,
  isArtifactMissing,
  readArtifactManifest,
  readArtifactPayload,
  syncArtifactDirectory,
  syncArtifactFile,
} from "./artifact-store-files.js";

export type {
  ArtifactBinding,
  ArtifactControllerRangeReadRequest,
  ArtifactProducer,
  ArtifactRangeRead,
  ArtifactRangeReadRequest,
  ArtifactStaging,
  ArtifactStoreOptions,
  ArtifactValidator,
  PublishArtifactRequest,
  PublishedArtifact,
} from "./artifact-store-contract.js";
export { ArtifactStoreError } from "./artifact-store-contract.js";

const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024;
const DEFAULT_MAX_RANGE_READ_BYTES = 32 * 1024;
const MANIFEST_FILE = "output/manifest.json";
const PAYLOAD_FILE = "output/result.json";

/** Host-owned immutable artifact store with atomic same-filesystem publication — issue #115 §6.
 *
 * Callers hold the controller's single live writer lease and issue unique action IDs. The
 * action namespace detects durable conflicts, but cannot serialize two independent writers.
 */
export class ArtifactStore {
  readonly #root: string;
  readonly #stagingRoot: string;
  readonly #publishedRoot: string;
  readonly #maxArtifactBytes: number;
  readonly #maxRangeReadBytes: number;
  readonly #assertPublicationOpen: (() => void) | undefined;
  readonly #testHook: ArtifactStoreOptions["testHook"];

  private constructor(
    root: string,
    maxArtifactBytes: number,
    maxRangeReadBytes: number,
    assertPublicationOpen: (() => void) | undefined,
    testHook: ArtifactStoreOptions["testHook"],
  ) {
    this.#root = root;
    this.#stagingRoot = join(root, "staging");
    this.#publishedRoot = join(root, "published");
    this.#maxArtifactBytes = maxArtifactBytes;
    this.#maxRangeReadBytes = maxRangeReadBytes;
    this.#assertPublicationOpen = assertPublicationOpen;
    this.#testHook = testHook;
  }

  /** Open a private host root and establish the same-filesystem staging/publication layout. */
  static async open(options: ArtifactStoreOptions): Promise<ArtifactStore> {
    const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    const maxRangeReadBytes = options.maxRangeReadBytes ?? DEFAULT_MAX_RANGE_READ_BYTES;
    if (
      !isPositiveArtifactInteger(maxArtifactBytes) ||
      !isPositiveArtifactInteger(maxRangeReadBytes) ||
      maxArtifactBytes > DEFAULT_MAX_ARTIFACT_BYTES ||
      maxRangeReadBytes > DEFAULT_MAX_RANGE_READ_BYTES
    )
      throw new ArtifactStoreError(
        "artifact-storage-failure",
        "artifact limits exceed controller artifact bounds",
      );
    let root: string;
    try {
      root = await canonicalTrustedSnapshotParent(options.root);
    } catch {
      throw new ArtifactStoreError(
        "artifact-storage-failure",
        "artifact root is not private and canonical",
      );
    }
    for (const child of ["staging", "published"]) {
      const path = join(root, child);
      await mkdir(path, { recursive: true, mode: 0o700 });
      try {
        await assertPrivateArtifactDirectory(path);
      } catch {
        throw new ArtifactStoreError("artifact-storage-failure");
      }
    }
    return new ArtifactStore(
      root,
      maxArtifactBytes,
      maxRangeReadBytes,
      options.assertPublicationOpen,
      options.testHook,
    );
  }

  /** Allocate an action-owned private staging directory and fixed output file path. */
  async createStaging(actionId: string): Promise<ArtifactStaging> {
    assertArtifactIdentifier(actionId, "action identifier");
    const actionDirectory = join(this.#stagingRoot, artifactSha256(actionId));
    await mkdir(actionDirectory, { recursive: true, mode: 0o700 });
    await assertArtifactDirectoryBeneath(
      this.#stagingRoot,
      actionDirectory,
      "artifact-staging-invalid",
    );
    const directory = join(actionDirectory, randomUUID());
    await mkdir(directory, { mode: 0o700 });
    await mkdir(dirname(join(directory, PAYLOAD_FILE)), { mode: 0o700 });
    return Object.freeze({ actionId, directory, outputPath: join(directory, PAYLOAD_FILE) });
  }

  /** Validate, fsync, and atomically promote an adapter output into immutable action-owned storage. */
  async publish(request: PublishArtifactRequest): Promise<PublishedArtifact> {
    assertArtifactBinding(request.binding);
    if (request.staging.actionId !== request.binding.actionId)
      throw new ArtifactStoreError(
        "artifact-binding-mismatch",
        "staging action does not match binding",
      );
    await assertArtifactDirectoryBeneath(
      this.#stagingRoot,
      request.staging.directory,
      "artifact-staging-invalid",
    );
    if (request.staging.outputPath !== join(request.staging.directory, PAYLOAD_FILE))
      throw new ArtifactStoreError(
        "artifact-staging-invalid",
        "staging output path is not host-issued",
      );

    const payload = await this.#readStagedPayload(request.staging);
    try {
      await request.validate(payload.bytes, request.binding);
    } catch {
      throw new ArtifactStoreError("artifact-schema-invalid");
    }
    this.#assertPublicationOpen?.();
    request.assertPublicationOpen?.();
    const content = Object.freeze({
      sha256: artifactSha256(payload.bytes),
      byte_length: payload.bytes.byteLength,
      media_type: request.binding.mediaType,
    });
    const manifest = buildArtifactManifest(request.binding, content);
    const destination = this.#pathForRef(manifest.ref);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await assertArtifactDirectoryBeneath(
      this.#publishedRoot,
      dirname(destination),
      "artifact-storage-failure",
    );
    // Persist the newly allocated action namespace before its child rename is acknowledged.
    await syncArtifactDirectory(this.#publishedRoot);
    await this.#assertActionNamespaceAvailable(destination);

    try {
      await lstat(destination);
      return this.#readPublished(manifest.ref, request.binding);
    } catch (cause) {
      if (!isArtifactMissing(cause)) throw cause;
    }

    await this.#writeManifest(request.staging.directory, manifest);
    await chmod(request.staging.outputPath, 0o400);
    await assertSameArtifactPayload(request.staging.outputPath, payload.identity);
    await syncArtifactFile(request.staging.outputPath);
    await chmod(dirname(request.staging.outputPath), 0o500);
    await syncArtifactDirectory(dirname(request.staging.outputPath));
    await syncArtifactDirectory(request.staging.directory);
    await this.#assertActionNamespaceAvailable(destination);
    // Do not await between this closure check and the synchronous rename invocation.
    this.#assertPublicationOpen?.();
    request.assertPublicationOpen?.();
    try {
      await rename(request.staging.directory, destination);
    } catch (cause) {
      if (!isArtifactDestinationExists(cause))
        throw new ArtifactStoreError("artifact-storage-failure");
      return this.#readPublished(manifest.ref, request.binding);
    }
    await this.#testHook?.("after-rename-before-parent-sync");
    await syncArtifactDirectory(destination);
    await syncArtifactDirectory(dirname(destination));
    await syncArtifactDirectory(this.#publishedRoot);
    return publishedArtifact(manifest);
  }

  /** Recover one already-published artifact only when its manifest and bytes still prove the binding. */
  async recover(request: {
    readonly ref: string;
    readonly binding: ArtifactBinding;
  }): Promise<PublishedArtifact> {
    assertArtifactBinding(request.binding);
    return this.#readPublished(request.ref, request.binding);
  }

  /** Recover an action's single deterministic publication after a crash before its receipt append. */
  async recoverAction(binding: ArtifactBinding): Promise<PublishedArtifact> {
    assertArtifactBinding(binding);
    const actionNamespace = artifactActionNamespace(binding);
    const directory = join(this.#publishedRoot, actionNamespace);
    let entries: readonly string[];
    try {
      entries = await readdir(directory);
    } catch (cause) {
      if (isArtifactMissing(cause)) throw new ArtifactStoreError("artifact-missing");
      throw new ArtifactStoreError("artifact-storage-failure");
    }
    if (entries.length === 0) throw new ArtifactStoreError("artifact-missing");
    if (entries.length !== 1 || !/^[a-f0-9]{64}$/u.test(entries[0] ?? ""))
      throw new ArtifactStoreError("artifact-conflict");
    const manifestHash = entries[0];
    if (manifestHash === undefined) throw new ArtifactStoreError("artifact-missing");
    return this.#readPublished(`artifact/v1/${actionNamespace}/${manifestHash}`, binding);
  }

  /** Resolve a host-issued ref for an authorized native consumer with a hard 32KiB default limit. */
  async rangeRead(request: ArtifactRangeReadRequest): Promise<ArtifactRangeRead> {
    const artifact = await this.#readBounded(request);
    if (!artifact.binding.allowedConsumerProfileIds.includes(request.consumerProfileId))
      throw new ArtifactStoreError("artifact-consumer-denied");
    return artifact;
  }

  /** Resolve a host-issued ref for the owning controller without forging a native profile grant. */
  async rangeReadForController(
    request: ArtifactControllerRangeReadRequest,
  ): Promise<ArtifactRangeRead> {
    return this.#readBounded(request);
  }

  async #readBounded(
    request: Omit<ArtifactRangeReadRequest, "consumerProfileId">,
  ): Promise<ArtifactRangeRead> {
    if (
      !isNonNegativeArtifactInteger(request.offset) ||
      !isPositiveArtifactInteger(request.length) ||
      request.length > this.#maxRangeReadBytes
    )
      throw new ArtifactStoreError("artifact-range-invalid");
    const artifact = await this.#readPublished(request.ref);
    if (
      artifact.binding.runId !== request.runId ||
      artifact.binding.definitionDigest !== request.definitionDigest
    )
      throw new ArtifactStoreError("artifact-binding-mismatch");
    if (request.offset > artifact.byteLength)
      throw new ArtifactStoreError("artifact-range-invalid");
    const length = Math.min(request.length, artifact.byteLength - request.offset);
    const payloadPath = join(this.#pathForRef(request.ref), PAYLOAD_FILE);
    const bytes = (await readArtifactPayload(payloadPath, this.#maxArtifactBytes)).bytes;
    if (bytes.byteLength !== artifact.byteLength || artifactSha256(bytes) !== artifact.sha256)
      throw new ArtifactStoreError("artifact-corrupt");
    return Object.freeze({
      bytes: bytes.subarray(request.offset, request.offset + length),
      binding: artifact.binding,
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
      mediaType: artifact.mediaType,
    });
  }

  /** Test-only internal path access; production callers receive opaque refs exclusively. */
  pathForTest(ref: string): string {
    return this.#pathForRef(ref);
  }

  async #readStagedPayload(
    staging: ArtifactStaging,
  ): Promise<{ readonly bytes: Buffer; readonly identity: ArtifactFileIdentity }> {
    return readArtifactPayload(staging.outputPath, this.#maxArtifactBytes);
  }

  async #writeManifest(stagingDirectory: string, manifest: ArtifactManifest): Promise<void> {
    const path = join(stagingDirectory, MANIFEST_FILE);
    try {
      await writeFile(path, JSON.stringify(manifest), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o400,
      });
      await syncArtifactFile(path);
    } catch (cause) {
      if (cause instanceof ArtifactStoreError) throw cause;
      throw new ArtifactStoreError("artifact-storage-failure");
    }
  }

  async #readPublished(ref: string, expectedBinding?: ArtifactBinding): Promise<PublishedArtifact> {
    const directory = this.#pathForRef(ref);
    await assertPrivateArtifactDirectory(this.#publishedRoot);
    await assertPrivateArtifactDirectory(dirname(directory));
    await assertPrivateArtifactDirectory(directory);
    await assertImmutableArtifactDirectory(join(directory, "output"));
    await assertImmutableArtifactFile(join(directory, MANIFEST_FILE));
    await assertImmutableArtifactFile(join(directory, PAYLOAD_FILE));
    const manifest = await readArtifactManifest(join(directory, MANIFEST_FILE));
    if (manifest.ref !== ref) throw new ArtifactStoreError("artifact-corrupt");
    if (expectedBinding !== undefined && !sameArtifactBinding(expectedBinding, manifest.binding))
      throw new ArtifactStoreError("artifact-binding-mismatch");
    const payload = (
      await readArtifactPayload(join(directory, PAYLOAD_FILE), this.#maxArtifactBytes)
    ).bytes;
    if (
      payload.byteLength !== manifest.content.byte_length ||
      artifactSha256(payload) !== manifest.content.sha256
    )
      throw new ArtifactStoreError("artifact-corrupt");
    return publishedArtifact(manifest);
  }

  #pathForRef(ref: string): string {
    const parsed = parseArtifactRef(ref);
    const path = join(this.#publishedRoot, parsed.actionHash, parsed.manifestHash);
    if (!isBeneath(this.#publishedRoot, path)) throw new ArtifactStoreError("artifact-missing");
    return path;
  }

  async #assertActionNamespaceAvailable(destination: string): Promise<void> {
    let entries: readonly string[];
    try {
      entries = await readdir(dirname(destination));
    } catch {
      throw new ArtifactStoreError("artifact-storage-failure");
    }
    const expected = basename(destination);
    if (entries.some((entry) => entry !== expected))
      throw new ArtifactStoreError("artifact-conflict");
  }
}

function isBeneath(root: string, path: string): boolean {
  const value = relative(root, path);
  return value.length > 0 && !value.startsWith("..") && !isAbsolute(value);
}
