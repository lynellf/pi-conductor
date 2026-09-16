/** Private immutable native child-output publication — issue #116 capability A. */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import {
  assertChildOutputBinding,
  assertChildOutputManifest,
  assertChildOutputPrincipal,
  buildChildOutputManifest,
  type ChildOutputBinding,
  type ChildOutputManifest,
  type ChildOutputPrincipal,
  ChildOutputStoreError,
  childOutputLimit,
  childOutputNamespace,
  childOutputSha256,
  MAX_CHILD_OUTPUT_TOTAL_BYTES,
  MAX_CHILD_OUTPUTS,
} from "./child-output-store-contract.js";
import {
  assertChildOutputAncestors,
  assertChildOutputDirectory,
  assertChildOutputFile,
  readChildOutputFile,
  syncChildOutputPath,
} from "./child-output-store-files.js";

export {
  type ChildOutputBinding,
  type ChildOutputPrincipal,
  ChildOutputStoreError,
} from "./child-output-store-contract.js";

export interface PublishedChildOutput {
  readonly ref: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: ChildOutputBinding["mediaType"];
  readonly binding: ChildOutputBinding;
}
export interface ChildOutputStoreOptions {
  readonly root: string;
  /** Operation-local epoch assertion, repeated immediately before canonical rename. */
  readonly assertPublicationOpen?: () => void;
  readonly testHook?: (stage: "after-rename-before-journal") => void | Promise<void>;
}

/**
 * Stores host-supplied child bytes; it never accepts a worktree path from a caller.
 * The process queue composes store instances; the host single-writer lease supplies
 * cross-process authority. This store does not claim a cross-process lock.
 */
export class ChildOutputStore {
  static #publicationTails = new Map<string, Promise<void>>();
  readonly #root: string;
  readonly #assertPublicationOpen: (() => void) | undefined;
  readonly #testHook: ChildOutputStoreOptions["testHook"];

  private constructor(
    root: string,
    assertPublicationOpen: (() => void) | undefined,
    testHook: ChildOutputStoreOptions["testHook"],
  ) {
    this.#root = root;
    this.#assertPublicationOpen = assertPublicationOpen;
    this.#testHook = testHook;
  }

  /** Open an exact private, canonical root controlled by the current host user. */
  static async open(options: ChildOutputStoreOptions): Promise<ChildOutputStore> {
    try {
      await mkdir(options.root, { recursive: true, mode: 0o700 });
      const root = await realpath(options.root);
      if (root !== options.root) throw new Error("non-canonical root");
      await assertChildOutputAncestors(root);
      await assertChildOutputDirectory(root, root, 0o700);
      return new ChildOutputStore(root, options.assertPublicationOpen, options.testHook);
    } catch (cause) {
      if (cause instanceof ChildOutputTestHookError) throw cause.cause;
      if (cause instanceof ChildOutputStoreError) throw cause;
      throw new ChildOutputStoreError("child-output-storage-failure");
    }
  }

  /** Copy caller-owned inputs synchronously, then serialize one child namespace. */
  async publish(request: {
    readonly binding: ChildOutputBinding;
    readonly bytes: Buffer;
    readonly inputAudience: readonly ChildOutputPrincipal[] | null;
  }): Promise<PublishedChildOutput> {
    this.#assertPublicationOpen?.();
    const bytes = Buffer.from(request.bytes);
    const binding = cloneBinding(request.binding);
    const inputAudience = cloneAudience(request.inputAudience);
    assertChildOutputBinding(binding);
    const key = `${this.#root}\0${childOutputNamespace(binding)}`;
    const prior = ChildOutputStore.#publicationTails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    ChildOutputStore.#publicationTails.set(key, tail);
    await prior;
    try {
      this.#assertPublicationOpen?.();
      return await this.#publishOne(binding, bytes, inputAudience);
    } finally {
      release?.();
      if (ChildOutputStore.#publicationTails.get(key) === tail)
        ChildOutputStore.#publicationTails.delete(key);
    }
  }

  async #publishOne(
    binding: ChildOutputBinding,
    bytes: Buffer,
    inputAudience: readonly ChildOutputPrincipal[] | null,
  ): Promise<PublishedChildOutput> {
    if (
      inputAudience !== null &&
      !binding.audience.every((principal) =>
        inputAudience.some((input) => samePrincipal(principal, input)),
      )
    )
      throw new ChildOutputStoreError("child-output-audience-denied");
    if (bytes.byteLength > childOutputLimit(binding.output.kind))
      throw new ChildOutputStoreError("child-output-oversized");
    const namespace = join(this.#root, childOutputNamespace(binding));
    try {
      await assertChildOutputDirectory(this.#root, this.#root, 0o700);
      await mkdir(namespace, { mode: 0o700 }).catch((cause) => {
        if (nodeCode(cause) !== "EEXIST") throw cause;
      });
      await assertChildOutputDirectory(this.#root, namespace, 0o700);
      await syncChildOutputPath(this.#root, true);
      const manifests = await this.#manifests(namespace);
      const same = manifests.find(
        (value) =>
          value.binding.output.id === binding.output.id &&
          value.binding.output.path === binding.output.path,
      );
      const candidate = buildChildOutputManifest(binding, bytes);
      if (same !== undefined) {
        if (
          same.content.sha256 !== candidate.content.sha256 ||
          sha256Canonical(same.binding) !== sha256Canonical(binding)
        )
          throw new ChildOutputStoreError("child-output-conflict");
        const published = await this.#read(same.ref, binding);
        this.#assertPublicationStillOpen();
        return published;
      }
      this.#assertCapacity(manifests, bytes.byteLength);
      return await this.#write(namespace, candidate, bytes);
    } catch (cause) {
      if (cause instanceof ChildOutputPublicationClosedError) throw cause.cause;
      if (cause instanceof ChildOutputTestHookError) throw cause.cause;
      if (cause instanceof ChildOutputStoreError) throw cause;
      throw new ChildOutputStoreError("child-output-storage-failure");
    }
  }

  async #write(
    namespace: string,
    manifest: ChildOutputManifest,
    bytes: Buffer,
  ): Promise<PublishedChildOutput> {
    const destination = this.#path(manifest.ref);
    const staging = join(namespace, `.staging-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      const payloadPath = join(staging, "payload");
      const manifestPath = join(staging, "manifest.json");
      await writeFile(payloadPath, bytes, { mode: 0o400, flag: "wx" });
      await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o400, flag: "wx" });
      await assertChildOutputFile(payloadPath);
      await assertChildOutputFile(manifestPath);
      await syncChildOutputPath(payloadPath, false);
      await syncChildOutputPath(manifestPath, false);
      await chmod(staging, 0o500);
      await syncChildOutputPath(staging, true);
      // Do not await between this closure check and the synchronous rename invocation.
      this.#assertPublicationStillOpen();
      await rename(staging, destination);
      try {
        await this.#testHook?.("after-rename-before-journal");
      } catch (cause) {
        throw new ChildOutputTestHookError(cause);
      }
      await syncChildOutputPath(destination, true);
      await syncChildOutputPath(namespace, true);
      await syncChildOutputPath(this.#root, true);
      return this.#published(manifest);
    } catch (cause) {
      if (nodeCode(cause) === "EEXIST" || nodeCode(cause) === "ENOTEMPTY")
        return this.#recoverPublishRace(manifest);
      await chmod(staging, 0o700).catch(() => undefined);
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw cause;
    }
  }

  /** Recover a committed output only after verifying its exact sealed bytes. */
  async recover(binding: ChildOutputBinding): Promise<PublishedChildOutput> {
    this.#assertPublicationOpen?.();
    const expected = cloneBinding(binding);
    assertChildOutputBinding(expected);
    const namespace = join(this.#root, childOutputNamespace(expected));
    await assertChildOutputDirectory(this.#root, namespace, 0o700);
    const manifest = (await this.#manifests(namespace)).find(
      (value) =>
        value.binding.output.id === expected.output.id &&
        value.binding.output.path === expected.output.path,
    );
    if (manifest === undefined) throw new ChildOutputStoreError("child-output-missing");
    const published = await this.#read(manifest.ref, expected);
    this.#assertPublicationOpen?.();
    return published;
  }

  /** Read bound bytes only for a principal in the immutable artifact ACL. */
  async read(request: {
    readonly ref: string;
    readonly principal: ChildOutputPrincipal;
    readonly expectedBinding: ChildOutputBinding;
  }): Promise<PublishedChildOutput & { readonly bytes: Buffer }> {
    const expected = cloneBinding(request.expectedBinding);
    const principal = clonePrincipal(request.principal);
    assertChildOutputBinding(expected);
    assertChildOutputPrincipal(principal);
    const output = await this.#read(request.ref, expected);
    if (!output.binding.audience.some((allowed) => samePrincipal(allowed, principal)))
      throw new ChildOutputStoreError("child-output-audience-denied");
    return output;
  }

  /** Test-only path access; production callers receive opaque refs. */
  pathForTest(ref: string): string {
    return this.#path(ref);
  }

  async #read(
    ref: string,
    expected: ChildOutputBinding,
  ): Promise<PublishedChildOutput & { readonly bytes: Buffer }> {
    const path = this.#path(ref);
    await assertChildOutputDirectory(this.#root, dirname(path), 0o700);
    await assertChildOutputDirectory(this.#root, path, 0o500, "child-output-corrupt");
    const manifest = await this.#readManifest(path);
    if (manifest.ref !== ref || sha256Canonical(manifest.binding) !== sha256Canonical(expected))
      throw new ChildOutputStoreError("child-output-binding-mismatch");
    const bytes = await readChildOutputFile(
      join(path, "payload"),
      childOutputLimit(manifest.binding.output.kind),
    );
    if (
      bytes.byteLength !== manifest.content.byte_length ||
      childOutputSha256(bytes) !== manifest.content.sha256
    )
      throw new ChildOutputStoreError("child-output-corrupt");
    return { ...this.#published(manifest), bytes };
  }

  async #manifests(namespace: string): Promise<readonly ChildOutputManifest[]> {
    let names: readonly string[];
    try {
      names = await readdir(namespace);
    } catch {
      throw new ChildOutputStoreError("child-output-storage-failure");
    }
    const manifests: ChildOutputManifest[] = [];
    for (const name of names) {
      if (name.startsWith(".staging-")) continue;
      if (!/^[a-f0-9]{64}$/u.test(name)) throw new ChildOutputStoreError("child-output-corrupt");
      manifests.push(await this.#readManifest(join(namespace, name)));
    }
    return manifests;
  }

  async #readManifest(directory: string): Promise<ChildOutputManifest> {
    await assertChildOutputDirectory(this.#root, directory, 0o500, "child-output-corrupt");
    let value: unknown;
    try {
      value = JSON.parse(
        (await readChildOutputFile(join(directory, "manifest.json"), 64 * 1024)).toString("utf8"),
      );
      assertChildOutputManifest(value);
    } catch {
      throw new ChildOutputStoreError("child-output-corrupt");
    }
    if (basename(directory) !== value.manifest_sha256 || this.#path(value.ref) !== directory)
      throw new ChildOutputStoreError("child-output-corrupt");
    return value;
  }

  #assertCapacity(manifests: readonly ChildOutputManifest[], byteLength: number): void {
    const total = manifests.reduce((sum, value) => sum + value.content.byte_length, byteLength);
    if (manifests.length + 1 > MAX_CHILD_OUTPUTS || total > MAX_CHILD_OUTPUT_TOTAL_BYTES)
      throw new ChildOutputStoreError("child-output-oversized");
  }

  #path(ref: string): string {
    const match = /^child-output\/v2\/([a-f0-9]{64})\/([a-f0-9]{64})$/u.exec(ref);
    if (match?.[1] === undefined || match[2] === undefined)
      throw new ChildOutputStoreError("child-output-missing");
    const path = join(this.#root, match[1], match[2]);
    if (relative(this.#root, path).startsWith(".."))
      throw new ChildOutputStoreError("child-output-missing");
    return path;
  }

  #published(manifest: ChildOutputManifest): PublishedChildOutput {
    return {
      ref: manifest.ref,
      sha256: manifest.content.sha256,
      byteLength: manifest.content.byte_length,
      mediaType: manifest.content.media_type,
      binding: freezePublishedBinding(manifest.binding),
    };
  }

  async #recoverPublishRace(manifest: ChildOutputManifest): Promise<PublishedChildOutput> {
    const published = await this.#read(manifest.ref, manifest.binding);
    this.#assertPublicationStillOpen();
    return published;
  }

  #assertPublicationStillOpen(): void {
    try {
      this.#assertPublicationOpen?.();
    } catch (cause) {
      throw new ChildOutputPublicationClosedError(cause);
    }
  }
}

class ChildOutputTestHookError {
  constructor(readonly cause: unknown) {}
}
class ChildOutputPublicationClosedError {
  constructor(readonly cause: unknown) {}
}

function cloneBinding(binding: ChildOutputBinding): ChildOutputBinding {
  try {
    return structuredClone(binding);
  } catch {
    throw new ChildOutputStoreError("child-output-binding-invalid");
  }
}
function cloneAudience(
  audience: readonly ChildOutputPrincipal[] | null,
): readonly ChildOutputPrincipal[] | null {
  if (audience === null) return null;
  try {
    const copy: unknown = structuredClone(audience);
    if (!Array.isArray(copy)) throw new Error("invalid audience");
    for (const principal of copy) assertChildOutputPrincipal(principal);
    return copy as ChildOutputPrincipal[];
  } catch {
    throw new ChildOutputStoreError("child-output-binding-invalid");
  }
}
function clonePrincipal(principal: ChildOutputPrincipal): ChildOutputPrincipal {
  try {
    return structuredClone(principal);
  } catch {
    throw new ChildOutputStoreError("child-output-binding-invalid");
  }
}
function freezePublishedBinding(binding: ChildOutputBinding): ChildOutputBinding {
  const copy = cloneBinding(binding);
  Object.freeze(copy.terminal);
  Object.freeze(copy.output);
  for (const principal of copy.audience) Object.freeze(principal);
  Object.freeze(copy.audience);
  return Object.freeze(copy);
}
function nodeCode(cause: unknown): string | undefined {
  return cause !== null && typeof cause === "object" && "code" in cause
    ? String((cause as { readonly code?: unknown }).code)
    : undefined;
}
function samePrincipal(left: ChildOutputPrincipal, right: ChildOutputPrincipal): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "controller" || right.kind === "controller") return true;
  if (left.kind === "native" && right.kind === "native")
    return left.profile_id === right.profile_id;
  if (left.kind === "adapter" && right.kind === "adapter")
    return left.adapter_id === right.adapter_id;
  return left.kind === "effect" && right.kind === "effect" && left.effect_id === right.effect_id;
}
