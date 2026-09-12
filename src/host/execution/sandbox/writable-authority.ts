/** Exact delegated projection and writable namespace authority — Issue #106 §§2–4. */

/** One frozen writable capability; directories additionally authorize new descendants. */
export interface SandboxWritableRoot {
  readonly path: string;
  readonly kind: "file" | "directory";
}

/** Complete pinned-base metadata required to resolve writable authority before queueing. */
export interface SandboxWritableAuthorityInput {
  readonly writablePaths: readonly string[];
  readonly selectedPaths: readonly string[];
  /** Every tracked base path, including omitted materialized and sparse entries. */
  readonly trackedPaths: readonly string[];
  /** Effective allowed/default policy roots, when the profile constrains projection. */
  readonly projectionRoots?: readonly string[];
}

/** Writable authority cannot be established from ambiguous or incomplete projection data. */
export class SandboxWritableAuthorityError extends Error {
  constructor(
    readonly code:
      | "sandbox-projection-inconsistent"
      | "sandbox-writable-invalid-path"
      | "sandbox-writable-overlap"
      | "sandbox-writable-outside-projection"
      | "sandbox-writable-excluded-descendant",
    readonly path: string,
  ) {
    super(`${code}: ${JSON.stringify(path)}`);
    this.name = "SandboxWritableAuthorityError";
  }
}

/** Resolve file/directory writes without broadening the admitted exact projection (#106 §2). */
export function resolveSandboxWritableAuthority(
  input: SandboxWritableAuthorityInput,
): readonly SandboxWritableRoot[] {
  const tracked = new Set(input.trackedPaths);
  const selected = new Set(input.selectedPaths);
  if (tracked.size !== input.trackedPaths.length || selected.size !== input.selectedPaths.length)
    throw new SandboxWritableAuthorityError("sandbox-projection-inconsistent", "duplicate paths");
  if (input.projectionRoots !== undefined) {
    if (
      input.projectionRoots.length === 0 ||
      new Set(input.projectionRoots).size !== input.projectionRoots.length ||
      input.projectionRoots.some((root) => !isProjectPath(root))
    )
      throw new SandboxWritableAuthorityError(
        "sandbox-projection-inconsistent",
        "projection roots",
      );
  }
  for (const path of selected) {
    if (!isProjectPath(path) || !tracked.has(path))
      throw new SandboxWritableAuthorityError("sandbox-projection-inconsistent", path);
  }
  const roots: SandboxWritableRoot[] = [];
  for (const path of [...input.writablePaths].sort()) {
    if (!isProjectPath(path))
      throw new SandboxWritableAuthorityError("sandbox-writable-invalid-path", path);
    if (roots.some((root) => covers(root.path, path) || covers(path, root.path)))
      throw new SandboxWritableAuthorityError("sandbox-writable-overlap", path);
    if (
      input.projectionRoots !== undefined &&
      !input.projectionRoots.some((root) => covers(root, path))
    )
      throw new SandboxWritableAuthorityError("sandbox-writable-outside-projection", path);
    const kind = selected.has(path) ? "file" : "directory";
    if (kind === "directory") {
      if (![...selected].some((entry) => covers(path, entry)))
        throw new SandboxWritableAuthorityError("sandbox-writable-outside-projection", path);
      if ([...tracked].some((entry) => covers(path, entry) && !selected.has(entry)))
        throw new SandboxWritableAuthorityError("sandbox-writable-excluded-descendant", path);
    }
    roots.push(Object.freeze({ path, kind }));
  }
  return Object.freeze(roots);
}

/** Shared literal-path authority predicate for mounts, confined file tools, and ingestion. */
export function isSandboxWritablePath(
  authority: readonly SandboxWritableRoot[],
  path: string,
): boolean {
  return (
    isProjectPath(path) &&
    authority.some(
      (root) =>
        isProjectPath(root.path) &&
        ((root.kind === "file" && path === root.path) ||
          (root.kind === "directory" && covers(root.path, path))),
    )
  );
}

function covers(root: string, path: string): boolean {
  return root === path || path.startsWith(`${root}/`);
}

function isProjectPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("~") &&
    !/^[A-Za-z]:/.test(path) &&
    !/[\\\0*?[\]{}]/.test(path) &&
    path
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          part !== ".git" &&
          part !== ".pi-conductor",
      )
  );
}
