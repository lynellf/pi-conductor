/**
 * Issue #139 Phase 3: conservative reconstruction-signal classifier.
 *
 * Observability only — a heuristic, not an enforcement mechanism. The
 * classifier is deliberately narrow and documented:
 *
 * - `broad_find`: a `bash` invocation whose parsed command is `find`
 *   over `.`/workspace root without a restrictive `-maxdepth`;
 * - `wide_rg`: a `bash` invocation whose parsed command is `rg` with no
 *   path or `.`/workspace root as its search root;
 * - `predecessor_context_read`: an invocation of the host-mediated
 *   `handoff_context` tool.
 *
 * Direct filesystem reads outside host-mediated tools are unobservable.
 * Command fingerprints are SHA-256 hex prefixes (12 chars); raw commands
 * and secrets are never stored. Thresholds and parsing are unit-tested.
 *
 * Pure; no I/O, no pi imports.
 */

import { createHash } from "node:crypto";
import type { ReconstructionSignalKind } from "../persistence/reconstruction-signal.js";

/** Hash-only fingerprint for a normalized command (never the raw text). */
export function fingerprintCommand(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12);
}

/** Normalize a command for parsing: trim, collapse whitespace. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function firstToken(normalized: string): string {
  const token = normalized.split(" ")[0] ?? "";
  const base = token.split("/").pop() ?? token;
  return base;
}

function hasMaxdepth(normalized: string): boolean {
  return /(^|\s)-maxdepth(\s|$|=)/.test(normalized) || /(^|\s)--maxdepth(\s|$|=)/.test(normalized);
}

/**
 * Classify a `bash` tool command. Returns `broad_find`, `wide_rg`, or
 * null (no signal). Parsing is intentionally conservative: unknown
 * shapes yield no signal rather than a false positive.
 */
export function classifyBashCommand(
  command: string,
): Extract<ReconstructionSignalKind, "broad_find" | "wide_rg"> | null {
  const normalized = normalizeCommand(command);
  if (normalized.length === 0) return null;
  const tool = firstToken(normalized);
  if (tool === "find") {
    // Broad only when searching `.`/workspace root without -maxdepth.
    const searchesRoot =
      /(^|\s)(\.|\/|\$PWD|\$WORKSPACE|~)(\s|$)/.test(normalized) ||
      /^find\s*$/.test(normalized) ||
      /^find\s+[^\s-][^\s]*\s*$/.test(normalized);
    if (searchesRoot && !hasMaxdepth(normalized)) return "broad_find";
    return null;
  }
  if (tool === "rg" || tool === "ripgrep") {
    // `rg [OPTIONS] PATTERN [PATH...]`: the first positional is the
    // pattern, the rest are search roots. Wide when no root is given
    // (pattern only) or every root is `.`/workspace root.
    const parts = normalized.split(" ").slice(1);
    const positionals = parts.filter(
      (part) => part.length > 0 && !part.startsWith("-") && !part.includes("="),
    );
    if (positionals.length <= 1) return "wide_rg";
    const roots = positionals.slice(1);
    if (roots.length > 0 && roots.every((root) => root === "." || root === "/")) {
      return "wide_rg";
    }
    return null;
  }
  return null;
}

/** Classify a host-mediated tool invocation by name. */
export function classifyHostTool(
  toolName: string,
): Extract<ReconstructionSignalKind, "predecessor_context_read"> | null {
  return toolName === "handoff_context" ? "predecessor_context_read" : null;
}
