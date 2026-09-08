import type { LoadedManifest } from "./manifest.js";
import { assertSupportedWorkspaceBackend } from "./workspace/index.js";

/** Reject unsupported role workspace backends before creating run state. */
export function assertManifestWorkspaceBackendsSupported(loaded: LoadedManifest): void {
  for (const role of loaded.manifest.roles) {
    const backend = role.workspace?.backend;
    if (backend !== undefined) assertSupportedWorkspaceBackend(backend);
  }
}
