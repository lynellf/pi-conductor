/** Descriptor-anchored `/workspace` overlay for sandbox file tools (#106 §4). */

import { type SandboxDirectory, withSandboxDirectory } from "./anchored-file-access.js";
import { isSandboxWritablePath, type SandboxWritableRoot } from "./writable-authority.js";
import { assertSandboxWritableEntries } from "./writable-entries.js";

/** One safe virtual workspace file, resolved from the private writable tree or base. */
export interface SandboxProjectFile {
  readonly path: string;
  readonly source: "base" | "writable";
  readonly size: number;
}

/** Reject unsupported child output before any base-tree access. */
export async function validateWritableProjectTree(
  writablePath: string,
  authority: readonly SandboxWritableRoot[],
): Promise<readonly SandboxProjectFile[]> {
  return withSandboxDirectory(writablePath, async (writable) => {
    const entries = await writable.entries(10_000);
    assertSandboxWritableEntries(entries, authority);
    return entries
      .filter((entry) => entry.type === "file")
      .map((entry) => ({ path: entry.path, source: "writable" as const, size: entry.size }));
  });
}

/** Open the project overlay only after its whole writable side passed validation. */
export async function withSandboxProjectFileView<T>(
  basePath: string,
  writablePath: string,
  authority: readonly SandboxWritableRoot[],
  operation: (view: SandboxProjectFileView) => Promise<T>,
): Promise<T> {
  return withSandboxDirectory(writablePath, async (writable) => {
    const writableEntries = await writable.entries(10_000);
    assertSandboxWritableEntries(writableEntries, authority);
    return withSandboxDirectory(basePath, async (base) =>
      operation(new SandboxProjectFileView(base, writable, authority, writableEntries)),
    );
  });
}

/** Read and write an exact merged view without path-based filesystem operations. */
export class SandboxProjectFileView {
  private readonly writableFiles: Set<string>;

  constructor(
    private readonly base: SandboxDirectory,
    private readonly writable: SandboxDirectory,
    private readonly authority: readonly SandboxWritableRoot[],
    writableEntries: readonly { readonly path: string; readonly type: "file" | "directory" }[],
  ) {
    this.writableFiles = new Set(
      writableEntries.filter((entry) => entry.type === "file").map((entry) => entry.path),
    );
  }

  /** Read a merged workspace file with the writable copy taking precedence. */
  async read(path: string, maxBytes: number): Promise<Buffer> {
    return isSandboxWritablePath(this.authority, path)
      ? this.writable.read(path, maxBytes)
      : this.base.read(path, maxBytes);
  }

  /** Write only within the pinned writable authority. */
  async write(path: string, content: Uint8Array): Promise<void> {
    if (!isSandboxWritablePath(this.authority, path))
      throw new Error(`sandbox path '${path}' is read-only`);
    const parent = path.lastIndexOf("/");
    if (parent > 0) await this.writable.mkdir(path.slice(0, parent));
    await this.writable.write(path, content);
    this.writableFiles.add(path);
  }

  /** Return the merged regular-file namespace, excluding writable ancestors. */
  async files(): Promise<readonly SandboxProjectFile[]> {
    const [baseEntries, writableEntries] = await Promise.all([
      this.base.entries(10_000),
      this.writable.entries(10_000),
    ]);
    const files = new Map<string, SandboxProjectFile>();
    for (const entry of baseEntries)
      if (entry.type === "file" && !isSandboxWritablePath(this.authority, entry.path))
        files.set(entry.path, { path: entry.path, source: "base", size: entry.size });
    for (const entry of writableEntries)
      if (entry.type === "file")
        files.set(entry.path, { path: entry.path, source: "writable", size: entry.size });
    return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  }
}

/** A directory root permits descendants; a file root permits that literal file only. */
export function isWritableFilePath(
  path: string,
  authority: readonly SandboxWritableRoot[],
): boolean {
  return isSandboxWritablePath(authority, path);
}
