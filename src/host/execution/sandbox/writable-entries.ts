/** Shared writable-tree validation for sandbox file tools and patch ingestion (#106 §4). */

import type { SandboxFileEntry } from "./anchored-file-access.js";
import { isSandboxWritablePath, type SandboxWritableRoot } from "./writable-authority.js";

/** Reject unsupported roots and hidden write authority before file tools or ingestion read bytes. */
export function assertSandboxWritableEntries(
  entries: readonly SandboxFileEntry[],
  roots: readonly SandboxWritableRoot[],
): void {
  for (const root of roots) {
    const entry = entries.find((entry) => entry.path === root.path);
    if (entry === undefined || entry.type !== (root.kind === "file" ? "file" : "directory"))
      throw new Error(`writable mount root '${root.path}' changed or disappeared`);
  }
  for (const entry of entries) {
    if (isSandboxWritablePath(roots, entry.path)) continue;
    if (entry.type === "directory" && roots.some((root) => root.path.startsWith(`${entry.path}/`)))
      continue;
    throw new Error(`unsupported output outside writable authority: ${JSON.stringify(entry.path)}`);
  }
}
