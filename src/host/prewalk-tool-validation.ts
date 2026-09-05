/** Command parsing and symlink-aware workspace validation for `execution_checkpoint`. */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";

/** Return a safe single command's executable basename, or null when shell syntax is unsafe. */
export function checkpointExecutable(command: string): string | null {
  if (command.trim() !== command || /[\r\n]/u.test(command)) return null;
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    const next = command[index + 1];
    if (quote === null && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (quote !== "'" && (char === "`" || (char === "$" && next === "("))) return null;
    if (quote === null && /[;&|<>]/u.test(char)) return null;
    if (char === "\\" && quote !== "'") {
      index += 1;
      if (index >= command.length) return null;
      word += command[index];
      continue;
    }
    if (quote === null && /\s/u.test(char)) {
      if (word.length > 0) words.push(word);
      word = "";
      continue;
    }
    word += char;
  }
  if (quote !== null) return null;
  if (word.length > 0) words.push(word);
  const executable = words[0];
  return executable === undefined ? null : basename(executable.replaceAll("\\", "/"));
}

/** Validate a normalized relative path, including symlink-aware containment of its nearest ancestor. */
export function isCheckpointPathContained(path: string, workspaceRoot: string): boolean {
  if (
    path.length === 0 ||
    path.trim() !== path ||
    path.includes("\\") ||
    isAbsolute(path) ||
    win32.isAbsolute(path)
  ) {
    return false;
  }
  let workspaceRootReal: string;
  try {
    workspaceRootReal = realpathSync(resolve(workspaceRoot));
  } catch {
    return false;
  }
  const candidate = resolve(workspaceRootReal, path);
  if (
    path !== posix.normalize(path) ||
    path.startsWith("./") ||
    path.endsWith("/") ||
    !isWithinRoot(candidate, workspaceRootReal)
  ) {
    return false;
  }
  return nearestExistingAncestorIsContained(candidate, workspaceRootReal);
}

function nearestExistingAncestorIsContained(candidate: string, workspaceRoot: string): boolean {
  for (;;) {
    try {
      return isWithinRoot(realpathSync(candidate), workspaceRoot);
    } catch (error) {
      if (!isNotFound(error)) return false;
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const contained = relative(root, candidate);
  return (
    contained === "" ||
    (contained !== ".." && !contained.startsWith(`..${sep}`) && !isAbsolute(contained))
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
