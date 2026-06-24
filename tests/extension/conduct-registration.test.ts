/**
 * Phase 7B Task 7B.1 — Extension command + flag registration.
 *
 * The plan's 7B.1 acceptance: the factory registers the
 * four commands (`/conduct`, `/conduct:resume`,
 * `/conduct:list`, `/conduct:abort`) + the
 * `--conduct-manifest` flag, and the factory itself does
 * NOT start any long-lived work. The active-run tracker
 * is `null` after the factory returns.
 *
 * Test surface: `loadExtension` from
 * `tests/extension/conduct-harness.ts` invokes the
 * factory with a recording fake `ExtensionAPI` and
 * returns the registered commands + flags. The harness
 * is a structural subset of pi's real harness
 * (`loadExtensionFromFactory`); the names + descriptions
 * + handler functions the test asserts are the same
 * names + descriptions + handler functions pi sees.
 *
 * Companion tests:
 *   - `conduct-start.test.ts` — Task 7B.2
 *   - `conduct-resume.test.ts` — Task 7B.3 (resume)
 *   - `conduct-list.test.ts` — Task 7B.3 (list)
 *   - `conduct-abort.test.ts` — Task 7B.3 (abort)
 *   - `conduct-e2e.test.ts` — Task 7B.4 (E2E)
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadExtension } from "./conduct-harness.js";

describe("extension shell — Task 7B.1: registration", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-conduct-registration-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("exports a default function that is the extension factory", async () => {
    // Loading the extension exercises the default
    // export. The factory must be a function — that's
    // what pi's `loadExtensionFromFactory` requires.
    const ext = await loadExtension("<test>", cwd);
    expect(ext.commands).toBeInstanceOf(Map);
    expect(ext.flags).toBeInstanceOf(Map);
  });

  it("registers the four commands with stable names", async () => {
    const ext = await loadExtension("<test>", cwd);
    const names = Array.from(ext.commands.keys()).sort();
    // The plan's 7B.1 acceptance: `/conduct`,
    // `/conduct:resume`, `/conduct:list`, `/conduct:abort`
    // are all registered.
    expect(names).toEqual(["conduct", "conduct:abort", "conduct:list", "conduct:resume"]);
  });

  it("registers the --conduct-manifest flag with type=string and no pinned default", async () => {
    const ext = await loadExtension("<test>", cwd);
    const flag = ext.flags.get("conduct-manifest");
    expect(flag).toBeDefined();
    expect(flag?.type).toBe("string");
    // The plan defers the default to the resolver
    // (the default path is `<cwd>/.pi/conductor.yaml`,
    // but the factory itself does not pin it on the
    // flag — the command handler reads the flag value
    // and falls back to the resolver).
    expect(flag?.default).toBeUndefined();
  });

  it("does not start any long-lived work from the factory itself (7B.1 acceptance)", async () => {
    // The factory is the 7B.1 acceptance gate. If
    // the factory started a run, the active-run
    // tracker would be non-null after
    // `loadExtension` returns.
    const { getActiveRun } = await import("../../src/extension/active-run.js");
    await loadExtension("<test>", cwd);
    expect(getActiveRun()).toBeNull();
  });

  it("attaches a non-empty description to each command", async () => {
    const ext = await loadExtension("<test>", cwd);
    for (const name of ["conduct", "conduct:resume", "conduct:list", "conduct:abort"]) {
      const cmd = ext.commands.get(name);
      expect(cmd?.description).toBeDefined();
      expect(cmd?.description?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("registers both conduct.role.text and conduct.role.tool renderers (Phase 7B.UX restored tool customType)", async () => {
    // Phase 7B.UX restored the `conduct.role.tool` customType for
    // tool-call and tool-result display events. Both renderers are
    // now registered at loadExtension time.
    const ext = await loadExtension("<test>", cwd);
    expect(ext.messageRenderers.has("conduct.role.text")).toBe(true);
    expect(ext.messageRenderers.has("conduct.role.tool")).toBe(true);
    expect(ext.messageRenderers.get("conduct.role.text")).toBeTypeOf("function");
    expect(ext.messageRenderers.get("conduct.role.tool")).toBeTypeOf("function");
  });
});
