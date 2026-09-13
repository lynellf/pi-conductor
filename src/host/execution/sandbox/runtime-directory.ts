/** Canonical directory observations with bounded diagnostics — #106 §3 / #108. */
import { lstat, realpath } from "node:fs/promises";
import { posix } from "node:path";
import { PreparedRuntimeCaptureError } from "./runtime-files.js";

/** Quote a bounded path preview without allowing filename control characters in diagnostics. */
export function formatRuntimePath(path: string): string {
  return `${JSON.stringify(path.slice(0, 160))}${path.length > 160 ? " (truncated)" : ""}`;
}

/** Require an existing canonical directory and preserve the failing observation category. */
export async function canonicalRuntimeDirectory(path: string, label: string): Promise<string> {
  const description = `${label} ${formatRuntimePath(path)}`;
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path.includes("\0")) {
    throw new PreparedRuntimeCaptureError(
      `${description} is noncanonical`,
      "runtime-invalid-source",
    );
  }
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new PreparedRuntimeCaptureError(
        `${description} is a symlink`,
        "runtime-invalid-source",
      );
    }
    if (!stat.isDirectory()) {
      throw new PreparedRuntimeCaptureError(
        `${description} is not a directory`,
        "runtime-invalid-source",
      );
    }
    if ((await realpath(path)) !== path) {
      throw new PreparedRuntimeCaptureError(
        `${description} is noncanonical`,
        "runtime-invalid-source",
      );
    }
    return path;
  } catch (cause) {
    if (cause instanceof PreparedRuntimeCaptureError) throw cause;
    const rawCode =
      typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
    const code =
      typeof rawCode === "string" && /^[A-Z0-9_]{1,40}$/.test(rawCode) ? rawCode : "UNKNOWN";
    const reason =
      code === "ENOENT"
        ? "is missing"
        : code === "ENOTDIR"
          ? "has a non-directory path component"
          : "could not be inspected";
    throw new PreparedRuntimeCaptureError(
      `${description} ${reason} (${code})`,
      "runtime-invalid-source",
      { cause },
    );
  }
}
