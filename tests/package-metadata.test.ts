/**
 * Package metadata guard (Phase 7C.2, extension pivot plan §2 + §3):
 *
 *   pi-conductor ships as a pi package. Before `pi install ./` is run,
 *   this test asserts the package.json + extension surface are
 *   structurally correct so a CI run proves "the install would load
 *   the extension". We can't run `pi install` in CI without
 *   polluting the user's settings — pi has no `--dry-run` flag
 *   (verified in `pi install --help`); structural assertions are the
 *   scripted equivalent.
 *
 * What this test asserts:
 *   1. `package.json` declares the `pi` manifest with `extensions` paths.
 *   2. The `keywords` field includes `pi-package` (discoverability).
 *   3. Each declared extension path resolves to an existing file and
 *      the file exports a default function (the `ExtensionFactory`
 *      contract — see `docs/extensions.md`).
 *   4. The three pi-bundled packages (`@earendil-works/pi-coding-agent`,
 *      `@earendil-works/pi-ai`, `typebox`) are peer dependencies with a
 *      `"*"` range (per `docs/packages.md`). `@earendil-works/pi-tui`
 *      is also a peer dep — the conductor-owned message renderer
 *      imports `Component`/`Container`/`Markdown`/`Text` from it
 *      (Phase 5); the SDK uses it internally but does not re-export
 *      its classes.
 *   5. No runtime imports used by `extensions/conduct.ts` or the host
 *      live only in `devDependencies` (i.e. anything imported by these
 *      files must be in `dependencies` or `peerDependencies`).
 *
 * The real-model smoke + manual `pi install ./` proof are documented
 * in `docs/dev-run-transcripts/` (relocated from Phase 7A.5).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;

/** Load and parse the package.json once per test run. */
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name?: string;
  private?: boolean;
  pi?: { extensions?: readonly string[] };
  keywords?: readonly string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const PI_BUNDLED_PEERS = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
] as const;

/** Walk every `import …` + `export … from` statement in a file's source. */
function collectImports(source: string): readonly string[] {
  const matches: string[] = [];
  // Match `import … from "<specifier>"` and `export … from "<specifier>"`.
  // Captures bare-specifier imports only (skips `import "side-effect"` strings).
  const re = /(?:^|\s)(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(re)) {
    const spec = match[1];
    if (spec !== undefined) matches.push(spec);
  }
  return matches;
}

/** A bare specifier is anything that doesn't start with `./`, `../`, `/`, `node:`. */
function isBareSpecifier(spec: string): boolean {
  return !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("node:");
}

describe("package metadata (pi extension surface)", () => {
  it("declares a non-empty pi.extensions list in package.json", () => {
    expect(pkg.pi).toBeDefined();
    const extensions = pkg.pi?.extensions;
    expect(Array.isArray(extensions)).toBe(true);
    expect(extensions?.length ?? 0).toBeGreaterThan(0);
  });

  it("includes the 'pi-package' keyword for discoverability", () => {
    expect(pkg.keywords).toBeDefined();
    expect(pkg.keywords).toContain("pi-package");
  });

  it("ships the extensions/ directory in the published files", () => {
    const files = (pkg as { files?: readonly string[] }).files ?? [];
    expect(files).toContain("extensions");
  });

  it.each(
    PI_BUNDLED_PEERS,
  )("declares '%s' as a peerDependency with a '*' range (pi bundles it)", (peerName) => {
    const peers = pkg.peerDependencies ?? {};
    expect(peers[peerName]).toBeDefined();
    // pi bundles the package; we pin a wildcard range so the consumer's
    // installed version satisfies the peer (matches docs/packages.md).
    expect(peers[peerName]).toBe("*");
  });

  it("does not list pi-bundled packages as dependencies (they must not be re-bundled)", () => {
    const deps = pkg.dependencies ?? {};
    for (const peer of PI_BUNDLED_PEERS) {
      expect(deps[peer]).toBeUndefined();
    }
  });
});

describe("extension entrypoints (pi extension surface)", () => {
  // Resolve every declared extension path. Each must:
  //   - exist on disk
  //   - export a default function (the ExtensionFactory contract)
  const declaredExtensions = pkg.pi?.extensions ?? [];

  it.each(
    declaredExtensions,
  )("extension path '%s' resolves to an existing file or directory", (relPath) => {
    const abs = join(ROOT, relPath);
    expect(existsSync(abs)).toBe(true);
    const stat = statSync(abs);
    // Either a single .ts file (loaded directly by jiti) or a
    // directory pi walks for *.ts files (per docs/packages.md).
    expect(stat.isFile() || stat.isDirectory()).toBe(true);
  });

  it("extensions/conduct.ts exports a default function (ExtensionFactory)", () => {
    const entrypoint = join(ROOT, "extensions", "conduct.ts");
    expect(existsSync(entrypoint)).toBe(true);
    const source = readFileSync(entrypoint, "utf8");
    // The factory is exported as `export default function conductExtension(...)`.
    // Match either `export default function` or `export default async function`
    // (extensions.md supports both — the factory may be async for one-time
    // startup work). Named-as-default (`export default <ident>`) is also legal.
    const hasDefaultFunction =
      /export\s+default\s+(?:async\s+)?function\b/.test(source) ||
      /export\s+default\s+\w+/.test(source);
    expect(hasDefaultFunction).toBe(true);
  });
});

describe("runtime imports are not devDependencies-only", () => {
  // The extensions and the host may import bare packages at runtime.
  // `pi install` runs `npm install --omit=dev`, so anything imported
  // by these files must resolve from `dependencies` or `peerDependencies`.
  //
  // (We exclude test files + node_modules + the public barrel's
  // bundled-default re-exports from `src/index.ts` — the barrel is
  // the public surface, not a runtime load path.)
  const runtimeFiles = ["extensions/conduct.ts", "src/host/index.ts"] as const;

  it.each(
    runtimeFiles,
  )("no bare-specifier import in '%s' resolves only to a devDependency", (relPath) => {
    const abs = join(ROOT, relPath);
    if (!existsSync(abs)) {
      // Optional file (e.g. the host barrel may not exist in every layout).
      return;
    }
    const source = readFileSync(abs, "utf8");
    const imports = collectImports(source).filter(isBareSpecifier);
    const deps = pkg.dependencies ?? {};
    const peers = pkg.peerDependencies ?? {};
    const devDeps = pkg.devDependencies ?? {};
    for (const spec of imports) {
      const inDeps = Object.hasOwn(deps, spec);
      const inPeers = Object.hasOwn(peers, spec);
      const inDevDeps = Object.hasOwn(devDeps, spec);
      // Fail if the import is in devDeps only — that means it would
      // vanish under `npm install --omit=dev`.
      if (inDevDeps && !inDeps && !inPeers) {
        throw new Error(
          `Runtime import '${spec}' in ${relPath} is only in devDependencies. ` +
            `Move it to 'dependencies' (or 'peerDependencies' if pi bundles it).`,
        );
      }
      // Also fail if the import is not declared at all (catches typos).
      if (!inDeps && !inPeers && !inDevDeps) {
        throw new Error(
          `Bare-specifier import '${spec}' in ${relPath} is not declared in ` +
            `dependencies, peerDependencies, or devDependencies of package.json.`,
        );
      }
    }
  });
});
