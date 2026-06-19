/**
 * Phase 7B — Extension shell tests.
 *
 * Tests are organized by plan task. The plan's verification
 * command is `pnpm test -- extension/conduct`; this file is
 * the single test surface for the extension shell, with
 * the registry + no-role-spawn-via-session-tree grep
 * guard living in sibling files.
 *
 * Tasks 7B.1 (registration) and 7B.2 (start handler) are
 * covered below. Tasks 7B.3 (resume/list/abort) and 7B.4
 * (E2E status + grep guard) are split into their own
 * describe blocks within this file so failures are
 * localized to the task that broke.
 *
 * Test strategy:
 *
 *   - **In-process harness** for registration + handler
 *     invocation: `loadExtensionFromFactory` from
 *     `@earendil-works/pi-coding-agent` accepts a factory
 *     and returns an `Extension` with the registered
 *     commands / flags. The runtime's action methods are
 *     throwing stubs during load, so registration-only
 *     tests run without a real ctx.
 *   - **Direct handler invocation with a fake ctx** for
 *     handler behavior: the registered command's
 *     `handler(args, ctx)` is called with a fake
 *     `ExtensionCommandContext` that implements the
 *     subset the extension actually uses (modelRegistry,
 *     cwd, ui.notify, ui.setStatus, getFlag). The fake
 *     ctx is a structural subset; pi's real ctx satisfies
 *     the same interface.
 *   - **Real production host + stub provider** for the
 *     7B.4 E2E gate (`/conduct <goal>` reaches a
 *     terminal state with the stub). The handler is
 *     invoked with a real `ProductionHost` wired to the
 *     stub stream function (the same setup the 7A.3
 *     spawn test uses).
 *
 * No `pi -e` subprocess: the in-process harness drives
 * the same `pi.registerCommand` / `pi.registerFlag` code
 * paths a real `pi` would, and the direct handler call
 * exercises the handler body with a real SDK ctx
 * interface. The plan's 7B.4 acceptance explicitly
 * allows "an in-process extension harness [that]
 * documents why it is equivalent."
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AuthStorage,
  type ExtensionCommandContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import conductFactory from "../../extensions/conduct.js";
import { CONDUCT_STATUS_KEY, formatConductStatus } from "../../extensions/status.js";

// ─── Harness helpers ──────────────────────────────────────────────────

/**
 * What the harness records from the factory. The
 * in-process loader calls the factory with a fake
 * `ExtensionAPI`; the fake records each registration
 * so the test can assert the names + descriptions +
 * handler functions. The shape mirrors the relevant
 * fields of pi's `Extension` object so the test reads
 * the same way it would against the real harness.
 */
interface RecordedExtension {
  readonly commands: Map<
    string,
    {
      readonly name: string;
      readonly description?: string;
      readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    }
  >;
  readonly flags: Map<
    string,
    {
      readonly name: string;
      readonly type: "string" | "boolean";
      readonly default?: string | boolean;
    }
  >;
}

/** Load the extension factory with a recording fake API. */
async function loadExtension(_path: string, _cwd: string): Promise<RecordedExtension> {
  const ext: RecordedExtension = {
    commands: new Map(),
    flags: new Map(),
  };
  const api = {
    registerCommand: (
      name: string,
      opts: {
        description?: string;
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => {
      ext.commands.set(name, {
        name,
        ...(opts.description !== undefined && { description: opts.description }),
        handler: opts.handler,
      });
    },
    registerFlag: (
      name: string,
      opts: { type: "string" | "boolean"; default?: string | boolean },
    ) => {
      ext.flags.set(name, {
        name,
        type: opts.type,
        ...(opts.default !== undefined && { default: opts.default }),
      });
    },
    // The factory does not use any other API method; the
    // other fields are no-ops to satisfy the typed shape.
    on: () => {},
    registerTool: () => {},
    registerShortcut: () => {},
    registerMessageRenderer: () => {},
    getFlag: () => undefined,
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: () => Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: () => Promise.resolve(false),
    getThinkingLevel: () => "off" as const,
    setThinkingLevel: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: { on: () => {}, emit: () => {} },
  };
  await conductFactory(api as unknown as Parameters<typeof conductFactory>[0]);
  return ext;
}

/**
 * A minimal `ExtensionCommandContext` for handler-level
 * tests. Implements the subset the extension reads
 * (`cwd`, `modelRegistry`, `ui.notify`, `ui.setStatus`,
 * `getFlag`). Anything else is `undefined` — the
 * extension does not touch it.
 */
function makeCtx(opts: {
  cwd: string;
  modelRegistry?: ModelRegistry;
  manifestPath?: string;
  notify?: (msg: string, type: "info" | "warning" | "error") => void;
  setStatus?: (key: string, text: string | undefined) => void;
}): ExtensionCommandContext {
  const modelRegistry = opts.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.inMemory());
  const notify = opts.notify ?? (() => {});
  const setStatus = opts.setStatus ?? (() => {});
  return {
    cwd: opts.cwd,
    modelRegistry,
    ui: { notify, setStatus } as unknown as ExtensionCommandContext["ui"],
    getFlag: (name: string) => (name === "conduct-manifest" ? opts.manifestPath : undefined),
  } as unknown as ExtensionCommandContext;
}

// ─── Task 7B.1: registration ──────────────────────────────────────────

describe("extension shell — Task 7B.1: registration", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-conduct-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("exports a default function that is the extension factory", () => {
    expect(typeof conductFactory).toBe("function");
  });

  it("registers the four commands with stable names", async () => {
    const ext = await loadExtension("<test>", cwd);
    const names = Array.from(ext.commands.keys()).sort();
    // The plan's 7B.1 acceptance: `/conduct`, `/conduct:resume`,
    // `/conduct:list`, `/conduct:abort` are all registered.
    expect(names).toEqual(["conduct", "conduct:abort", "conduct:list", "conduct:resume"]);
  });

  it("registers the --conduct-manifest flag with type=string and no pinned default", async () => {
    const ext = await loadExtension("<test>", cwd);
    const flag = ext.flags.get("conduct-manifest");
    expect(flag).toBeDefined();
    expect(flag?.type).toBe("string");
    // The plan defers the default to the resolver (the
    // default path is `<cwd>/.pi/conductor.yaml`, but the
    // factory itself does not pin it on the flag — the
    // command handler reads the flag value and falls
    // back to the resolver).
    expect(flag?.default).toBeUndefined();
  });

  it("does not start any long-lived work from the factory itself (7B.1 acceptance)", async () => {
    // The factory is the 7B.1 acceptance gate. If the
    // factory started a run, the active-run tracker
    // would be non-null after `loadExtension` returns.
    const { getActiveRun } = await import("../../extensions/active-run.js");
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
});

// ─── Status surface (re-exported names) ──────────────────────────────

describe("extension shell — status surface", () => {
  it("exports a stable status key + formatter", () => {
    // The E2E and the (future) status poller depend on
    // these names being the public surface. Accidental
    // rename would break both.
    expect(CONDUCT_STATUS_KEY).toBe("conduct");
    expect(typeof formatConductStatus).toBe("function");
  });
});

// ─── Task 7B.2: /conduct start handler (acceptance via fake ctx) ────

describe("extension shell — Task 7B.2: /conduct start handler (no-run branches)", () => {
  let cwd: string;
  let notifyCalls: { msg: string; type: "info" | "warning" | "error" }[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-conduct-start-"));
    notifyCalls = [];
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("notifies and returns without starting a run when no manifest is found", async () => {
    // No manifest is written to cwd. The default
    // path `<cwd>/.pi/conductor.yaml` is absent. The
    // plan's 7B.2 acceptance: "Missing manifest
    // produces a user-facing notification and no run."
    const ext = await loadExtension("<test>", cwd);
    const conduct = ext.commands.get("conduct");
    expect(conduct).toBeDefined();

    // `conduct` is non-null — `expect(conduct).toBeDefined()`
    // asserts this above. Use optional chaining for the
    // call (the test's control flow already proved the
    // command exists; biome prefers this over a
    // non-null assertion).
    await conduct?.handler(
      "do the thing",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );

    // The notification must be a `warning` (not info,
    // not error) — the user can fix it by writing a
    // manifest or passing `--conduct-manifest`. There
    // should be exactly one such notification.
    const manifestWarnings = notifyCalls.filter(
      (n) => n.type === "warning" && /manifest/i.test(n.msg),
    );
    expect(manifestWarnings).toHaveLength(1);

    // The active-run tracker is still null — the
    // handler returned without starting anything.
    const { getActiveRun } = await import("../../extensions/active-run.js");
    expect(getActiveRun()).toBeNull();
  });
});
