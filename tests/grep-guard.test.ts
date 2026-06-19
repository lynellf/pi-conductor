import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Grep guard (spec §12, plan Checkpoint A): `src/core` and `src/manifest` (and later
 * `src/seam`, `src/cost`) must be host-agnostic — no imports of the pi SDK or any pi
 * runtime package. Only `src/host` may import `@earendil-works/pi-coding-agent`.
 *
 * This is the authoritative enforcement; it runs as part of `pnpm test` and on the
 * pre-push hook. Source files are scanned as text so a transient TS error can never
 * mask an illegal import.
 */
const RESTRICTED = ["@earendil-works/pi-coding-agent"];
const GUARDED_DIRS = ["src/core", "src/manifest", "src/seam", "src/cost"];

const ROOT = new URL("../", import.meta.url).pathname;

function listTs(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory not created yet (later phase)
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

describe("grep guard: host-agnostic core", () => {
  for (const dir of GUARDED_DIRS) {
    it(`${dir} imports no pi runtime package`, () => {
      const files = listTs(join(ROOT, dir));
      const offenders: string[] = [];
      for (const file of files) {
        const src = readFileSync(file, "utf8");
        for (const pkg of RESTRICTED) {
          if (src.includes(pkg)) {
            offenders.push(`${relative(ROOT, file)} imports "${pkg}"`);
          }
        }
      }
      expect(offenders, offenders.join("\n")).toEqual([]);
    });
  }
});
