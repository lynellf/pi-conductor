/** Per-parent delegation scope wiring for production hosts — async delegation §1. */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createDelegateTool, type DelegateToolFactoryOptions } from "./delegate-tool-factory.js";
import { createDelegateScheduler } from "./factory-scheduler.js";
import { DelegationManager } from "./manager.js";
import type { DelegationScheduler } from "./scheduler.js";

interface DelegationScope {
  readonly manager: DelegationManager;
  readonly scheduler: DelegationScheduler;
}

/** Owns one independent scheduler/manager pair for each logical parent. */
export class ProductionDelegationCoordinator {
  private readonly scopes = new Map<string, DelegationScope>();
  private readonly failures = new Map<string, unknown>();
  private readonly replacements = new Map<string, Promise<void>>();

  /** Build a delegate tool bound to the supplied logical parent identity. */
  async createTool(
    options: Omit<DelegateToolFactoryOptions, "manager" | "scheduler">,
    logicalParentId: string,
  ): Promise<ToolDefinition> {
    const replacement = this.replacements.get(logicalParentId);
    if (replacement !== undefined) {
      await replacement;
      return this.createTool(options, logicalParentId);
    }
    const priorFailure = this.failures.get(logicalParentId);
    if (priorFailure !== undefined) throw priorFailure;
    let scope = this.scopes.get(logicalParentId);
    if (scope !== undefined) {
      const oldScope = scope;
      const close = (async (): Promise<void> => {
        await oldScope.scheduler.close("replacing delegation scope");
        const failure = this.failures.get(logicalParentId);
        if (failure !== undefined) throw failure;
        if (this.scopes.get(logicalParentId) === oldScope) this.scopes.delete(logicalParentId);
      })();
      this.replacements.set(logicalParentId, close);
      try {
        await close;
      } finally {
        if (this.replacements.get(logicalParentId) === close) {
          this.replacements.delete(logicalParentId);
        }
      }
      scope = this.scopes.get(logicalParentId);
    }
    if (scope === undefined) {
      const manager = new DelegationManager();
      const scopedOptions = {
        ...options,
        manager,
        onFatal: (cause: unknown): void => {
          if (!this.failures.has(logicalParentId)) this.failures.set(logicalParentId, cause);
          options.onFatal?.(cause);
        },
      };
      scope = { manager, scheduler: createDelegateScheduler(scopedOptions, logicalParentId) };
      this.scopes.set(logicalParentId, scope);
    }
    return createDelegateTool({ ...options, manager: scope.manager, scheduler: scope.scheduler });
  }

  /** Settle all parent scopes before the host disposes or replaces a role. */
  async close(reason = "parent delegation scope closed"): Promise<void> {
    const scopes = [...this.scopes.values()];
    await Promise.all(scopes.map((scope) => scope.scheduler.close(reason)));
    this.scopes.clear();
  }

  /** Settle one logical parent without affecting sibling parent scopes. */
  async closeScope(logicalParentId: string, reason: string): Promise<void> {
    const scope = this.scopes.get(logicalParentId);
    if (scope === undefined) return;
    await scope.scheduler.close(reason);
    this.scopes.delete(logicalParentId);
  }

  failure(logicalParentId: string): unknown {
    return this.failures.get(logicalParentId);
  }

  failureDetail(logicalParentId: string): string | null {
    const cause = this.failure(logicalParentId);
    if (cause === undefined) return null;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return detail.slice(0, 512);
  }

  /** Return stable accepted child IDs currently known to a parent scope. */
  pending(logicalParentId: string): readonly string[] {
    const scope = this.scopes.get(logicalParentId);
    return scope === undefined ? [] : scope.scheduler.pendingChildIds();
  }

  /** Return all unsettled child handles while a parent is being replaced. */
  pendingAll(): readonly string[] {
    return [...this.scopes.keys()].flatMap((id) => this.pending(id));
  }
}
