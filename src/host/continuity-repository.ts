/** Canonical repository evidence lookup for durable continuity — spec §7. */

import { createHash } from "node:crypto";

import type { ContinuityEvidenceDiagnostic, RepositoryLookup } from "./continuity-evidence.js";
import { runCanonical } from "./controller/git-effect-operations.js";
import {
  canonicalGitDirectory,
  GIT_OBJECT_ID,
  isSafeGitPath,
} from "./execution/sandbox/trusted-git-validation.js";

/** Build a fail-closed lookup against one host-selected canonical checkout. */
export function createCanonicalRepositoryLookup(repositoryPath: string): RepositoryLookup {
  return {
    resolveCommit: async (input) => {
      if (!isSafeGitPath(input.path)) return missing("repository_unsafe_path");
      if (!GIT_OBJECT_ID.test(input.commit)) return missing("repository_not_in_canonical_history");
      if (
        (input.line_start === undefined) !== (input.line_end === undefined) ||
        (input.line_start !== undefined &&
          input.line_end !== undefined &&
          input.line_start > input.line_end)
      )
        return missing("repository_invalid_line_range");

      try {
        const repository = await canonicalGitDirectory(repositoryPath);
        const headCommit = (await runCanonical(repository, ["rev-parse", "--verify", "HEAD"]))
          .toString("utf8")
          .trim();
        if (!/^[0-9a-f]{40}$/u.test(headCommit))
          return missing("repository_not_in_canonical_history");
        await runCanonical(repository, ["merge-base", "--is-ancestor", input.commit, headCommit]);
        const content = await runCanonical(repository, [
          "cat-file",
          "blob",
          `${input.commit}:${input.path}`,
        ]);
        const selectedRange = selectRange(content, input.line_start, input.line_end);
        if (selectedRange === null) return missing("repository_invalid_line_range");
        // `sha256` is the optional blob digest from spec §7. The range is
        // validated independently; it never changes the digest subject.
        if (
          input.sha256 !== undefined &&
          createHash("sha256").update(content).digest("hex") !== input.sha256
        )
          return missing("repository_digest_mismatch");
        return {
          status: "verified" as const,
          head_commit: headCommit,
          resolved_path: input.path,
        };
      } catch {
        return missing("repository_not_in_canonical_history");
      }
    },
  };
}

function selectRange(
  content: Buffer,
  lineStart: number | undefined,
  lineEnd: number | undefined,
): Buffer | null {
  if (lineStart === undefined || lineEnd === undefined) return content;
  const starts = [0];
  for (let index = 0; index < content.length; index += 1)
    if (content[index] === 0x0a) starts.push(index + 1);
  const lineCount =
    content.length === 0
      ? 0
      : content[content.length - 1] === 0x0a
        ? starts.length - 1
        : starts.length;
  if (lineStart < 1 || lineEnd > lineCount) return null;
  const startOffset = starts[lineStart - 1];
  const endOffset = lineEnd === lineCount ? content.length : starts[lineEnd];
  if (startOffset === undefined || endOffset === undefined) return null;
  return content.subarray(startOffset, endOffset);
}

function missing(diagnostic: ContinuityEvidenceDiagnostic) {
  return { status: "missing" as const, diagnostic };
}
