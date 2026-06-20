/**
 * Shared test harness for the extension shell tests
 * (Phase 7B).
 *
 * The harness records registrations from the extension
 * factory and exposes a fake `ExtensionCommandContext`
 * the handlers can be invoked with directly. The
 * `loadExtensionFromFactory` from
 * `@earendil-works/pi-coding-agent` is not exported
 * under the package's `exports` field, so a small
 * recording API is the cleanest option. The recording
 * API mirrors the relevant fields of pi's `Extension`
 * object so the test reads the same way it would
 * against the real harness.
 */

import {
  AuthStorage,
  type ExtensionCommandContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

import conductFactory from "../../extensions/conduct.js";

/** Notification record captured by the fake ctx. */
export interface NotifyCall {
  readonly msg: string;
  readonly type: "info" | "warning" | "error";
}

/** Status update captured by the fake ctx. */
export interface StatusUpdate {
  readonly key: string;
  readonly text: string | undefined;
}

/**
 * What the harness records from the factory.
 * Mirrors pi's `Extension` shape (only the fields the
 * tests read).
 */
export interface RecordedExtension {
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
  /**
   * Message renderers registered via `pi.registerMessageRenderer`,
   * keyed by `customType`. Phase 5: the conductor-owned renderers
   * for `conduct.role.text` and `conduct.role.tool`. The harness
   * captures the function references; tests can call them
   * directly with a stub theme to assert on the returned
   * `Container` shape.
   */
  readonly messageRenderers: Map<
    string,
    (message: unknown, options: unknown, theme: unknown) => unknown
  >;
}

/**
 * Load the extension factory with a recording fake API.
 * The factory is invoked once; the returned
 * `RecordedExtension` exposes the registered commands
 * and flags. Async to mirror `loadExtensionFromFactory`'s
 * shape, even though registration itself is sync.
 */
export async function loadExtension(
  _extensionPath: string,
  _cwd: string,
): Promise<RecordedExtension> {
  const ext: RecordedExtension = {
    commands: new Map(),
    flags: new Map(),
    messageRenderers: new Map(),
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
    registerMessageRenderer: (
      customType: string,
      renderer: (message: unknown, options: unknown, theme: unknown) => unknown,
    ) => {
      ext.messageRenderers.set(customType, renderer);
    },
    // No-op stubs for the rest of the API surface the
    // factory might touch. The factory only calls
    // registerCommand / registerFlag / registerMessageRenderer;
    // the other methods are here only to satisfy the typed
    // shape.
    on: () => {},
    registerTool: () => {},
    registerShortcut: () => {},
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
export function makeCtx(opts: {
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
