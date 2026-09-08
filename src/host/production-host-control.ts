/** Abort, delegation settlement, and end-guard control operations. */

import type { ProductionDelegationCoordinator } from "./delegation/production-delegation.js";
import type { EndGuardRunRequest, EndGuardRunResult } from "./end-guard-runner.js";
import type { RoleSession } from "./host.js";
import type { ProductionPrewalkHost } from "./production-prewalk-host.js";
export interface ControlHostContext {
  readonly endGuardRunner: {
    abort(sessionId: string): Promise<void>;
    run(request: EndGuardRunRequest): Promise<EndGuardRunResult>;
  };
  readonly delegation: ProductionDelegationCoordinator;
  readonly delegationSessionKeys: Map<string, string>;
  readonly inactiveDelegationSessions: Set<string>;
  readonly prewalk: ProductionPrewalkHost;
}
export async function abortSession(
  ctx: ControlHostContext,
  session: RoleSession,
  _reason: string,
): Promise<void> {
  await ctx.endGuardRunner.abort(session.sessionId);
  const key = ctx.delegationSessionKeys.get(session.sessionId);
  if (key !== undefined) {
    ctx.inactiveDelegationSessions.add(session.sessionId);
    let parentAbortFailure: unknown;
    const parentAbort = ctx.prewalk.abort(session).catch((error: unknown) => {
      parentAbortFailure = error;
    });
    let childCloseFailure: unknown;
    try {
      await ctx.delegation.closeScope(key, _reason);
      ctx.delegationSessionKeys.delete(session.sessionId);
    } catch (error) {
      childCloseFailure = error;
    } finally {
      if (ctx.delegationSessionKeys.get(session.sessionId) === undefined)
        ctx.inactiveDelegationSessions.delete(session.sessionId);
      await parentAbort;
    }
    if (childCloseFailure !== undefined) throw childCloseFailure;
    if (parentAbortFailure !== undefined) throw parentAbortFailure;
    return;
  }
  await ctx.prewalk.abort(session);
}

export function pendingDelegationTasks(
  ctx: ControlHostContext,
  session: RoleSession,
): readonly string[] {
  const key = ctx.delegationSessionKeys.get(session.sessionId);
  return key === undefined ? [] : ctx.delegation.pending(key);
}

export async function settleDelegation(
  ctx: ControlHostContext,
  session: RoleSession,
  reason: string,
): Promise<void> {
  const key = ctx.delegationSessionKeys.get(session.sessionId);
  if (key === undefined) return;
  ctx.inactiveDelegationSessions.add(session.sessionId);
  try {
    await ctx.delegation.closeScope(key, reason);
    ctx.delegationSessionKeys.delete(session.sessionId);
  } finally {
    if (ctx.delegationSessionKeys.get(session.sessionId) === undefined)
      ctx.inactiveDelegationSessions.delete(session.sessionId);
  }
}

export function runEndGuard(
  ctx: ControlHostContext,
  request: EndGuardRunRequest,
): Promise<EndGuardRunResult> {
  return ctx.endGuardRunner.run(request);
}

export function sealSession(_ctx: ControlHostContext, _session: RoleSession): void {
  // No-op: sealing is owned by the handoff/end tool wrapper
  // (Task 15.5) flipping `SessionSeam.isSealed`. This method
  // is reserved for external consumers.
}
