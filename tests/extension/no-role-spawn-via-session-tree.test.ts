/**
 * Grep guard (extension side) — spec §9.5, plan Task 7B.4.
 *
 * The extension pivot plan §1 and the Phase 7A notes both
 * call this out: role sessions are spawned by the production
 * host via the standalone `createAgentSession`, NOT via
 * `ctx.newSession()` or `ctx.fork`. Using `newSession` or
 * `fork` for role sessions would put workers in pi's
 * session tree, which:
 *
 *   1. Reopens §9.5 (the rejection of "orchestration
 *      *as* extension tool/event handlers").
 *   2. Breaks §11.1 (the host-owned `run_id`-keyed
 *      append-only log; role-session records would live
 *      in pi's session tree, not the conductor's log).
 *
 * The pure-core grep guard (`tests/grep-guard.test.ts`)
 * enforces "no pi imports in `src/core` + `src/manifest`
 * + `src/seam` + `src/cost`". This test enforces the
 * extension-side counterpart: no role-spawning path uses
 * `ctx.newSession` or `ctx.fork`.
 *
 * Scans all .ts files under `extensions/` as text so a
 * transient TS error can never mask an illegal call.
 * Fails the test if the file references either
 * surface. The
 * `createProductionHost` factory in `src/host/` is
 * extension-agnostic by design (the factory's
 * `ExtensionContextInputs` is a structural subset of
 * `ExtensionCommandContext` defined in `src/host/`,
 * not imported from pi) — so role spawning goes through
 * `ProductionHost` only, which uses `createAgentSession`.
 *
 * Pattern check: the test scans for `ctx.newSession(`
 * and `ctx.fork(` literal substrings. The literal `(`
 * after the name avoids false positives on comments or
 * identifiers that happen to contain the substring.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url).pathname;
const EXTENSIONS_DIR = join(ROOT, "extensions");

/** Patterns the guard rejects. The trailing `(` avoids
 *  false positives on identifiers that happen to contain
 *  the substring (e.g., a hypothetical local variable
 *  `forkCount`). */
const REJECTED_PATTERNS: ReadonlyArray<{ readonly pattern: string; readonly rationale: string }> = [
  {
    pattern: "ctx.newSession(",
    rationale:
      "role sessions must use standalone createAgentSession (ProductionHost), not ctx.newSession (reopens §9.5)",
  },
  {
    pattern: "ctx.fork(",
    rationale:
      "role sessions must use standalone createAgentSession (ProductionHost), not ctx.fork (reopens §9.5)",
  },
];

function listTs(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory not created yet
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out = out.concat(listTs(full));
    } else if (st.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("grep guard (extension): no role-spawn via session-tree APIs", () => {
  it("extensions/**/*.ts never references ctx.newSession( or ctx.fork(", () => {
    const files = listTs(EXTENSIONS_DIR);
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const { pattern, rationale } of REJECTED_PATTERNS) {
        if (src.includes(pattern)) {
          offenders.push(`${relative(ROOT, file)} contains "${pattern}" — ${rationale}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
