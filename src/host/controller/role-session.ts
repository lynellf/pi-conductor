/** Non-SDK role session; the existing loop remains the only reducer owner — issue #115 §5. */
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { sha256Canonical } from "../../persistence/trajectory-records.js";
import type { EmissionCapture } from "../../seam/validate-emission.js";
import { subscribeToRecords } from "../record-emitter.js";
import type { ControllerSessionNotification, HostTermination } from "../role-session-contract.js";
import { runControllerPump } from "./driver-pump.js";
import type { ControllerRoleSession, ControllerRoleSessionOptions } from "./session-contract.js";

export type { ControllerRoleSession, ControllerRoleSessionOptions } from "./session-contract.js";

/** Create a host audit-backed driver. No process or model starts until prompt(). */
export async function createControllerRoleSession(
  options: ControllerRoleSessionOptions,
): Promise<ControllerRoleSession> {
  const fd = openSync(options.sessionFile, "wx", 0o600);
  let auditOpen = true;
  const audit = (value: unknown): void => {
    if (!auditOpen) throw new Error("controller audit is closed");
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  };
  try {
    audit({
      type: "controller_session",
      schema_version: 1,
      session_origin: "controller",
      run_id: options.activation.run_id,
      role_session_id: options.sessionId,
      controller_id: options.activation.controller_id,
      definition_digest: options.activation.definition_digest,
      activation_id: options.activation.activation_id,
      owner_epoch: options.activation.owner_epoch,
      coordinator_model_turns: 0,
    });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  const abort = new AbortController();
  let capture: readonly EmissionCapture[] = [];
  let termination: HostTermination | null = null;
  let failure: unknown;
  let closed = false;
  let disposed = false;
  let driver: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let wakeWaiter: (() => void) | undefined;
  let pendingWake = false;
  const sealedListeners = new Set<() => void>();

  const wake = (): void => {
    pendingWake = true;
    wakeWaiter?.();
    wakeWaiter = undefined;
    if (!closed && options.isRunCostCapReached()) stopForRunCostCap();
  };
  const wait = async (timeoutMs?: number): Promise<void> => {
    if (pendingWake) {
      pendingWake = false;
      return;
    }
    await new Promise<void>((resolve) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              wakeWaiter = undefined;
              resolve();
            }, timeoutMs);
      wakeWaiter = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
    });
    pendingWake = false;
  };
  const close = (): Promise<void> => {
    if (closing !== null) return closing;
    closed = true;
    options.fence.close();
    abort.abort();
    pendingWake = true;
    wakeWaiter?.();
    wakeWaiter = undefined;
    closing = (async () => {
      const settled = await Promise.allSettled([
        options.closeOwnedWork(),
        options.dispatcher.settle(),
      ]);
      const rejected = settled.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") {
        failure = rejected.reason;
        throw rejected.reason;
      }
    })();
    // Closure may be triggered by a synchronous record callback before prompt resumes.
    void closing.catch(() => undefined);
    return closing;
  };
  const stopForRunCostCap = (): void => {
    if (closed) return;
    termination = { kind: "run_cost_cap" };
    void close();
  };
  const fail = (cause: unknown): void => {
    failure ??= cause;
    void close();
  };
  const assertHealthy = (): void => {
    if (failure !== undefined) throw failure;
    if (options.isRunCostCapReached() && !closed) stopForRunCostCap();
    if (closed) throw new Error("controller lifetime closed");
  };
  const unsubscribe = subscribeToRecords((record) => {
    if ("run_id" in record && record.run_id === options.activation.run_id) wake();
  });
  const notifyController = (notification: ControllerSessionNotification): void => {
    if (closed) throw new Error("permanently closed controller cannot retry finish");
    if (
      notification.source.session_file !== options.sessionFile ||
      ("role_session_id" in notification.source &&
        notification.source.role_session_id !== options.sessionId)
    )
      throw new Error("controller finish notification belongs to another session");
    const digest = sha256Canonical(notification.source);
    if (
      !options
        .readRecords()
        .some(
          (record) =>
            "run_id" in record &&
            record.run_id === options.activation.run_id &&
            sha256Canonical(record) === digest,
        )
    )
      throw new Error("controller finish notification has no durable source");
    options.fence.reopen();
    capture = [];
    wake();
  };

  return {
    role: options.role,
    sessionId: options.sessionId,
    sessionFile: options.sessionFile,
    sessionOrigin: {
      kind: "controller",
      controllerId: options.activation.controller_id,
      definitionDigest: options.activation.definition_digest,
      activationId: options.activation.activation_id,
      ownerEpoch: options.activation.owner_epoch,
    },
    model: null,
    effort: "off",
    retries: 0,
    retryDelayMs: 0,
    wake,
    fail,
    stopForRunCostCap,
    ...(options.getControllerMetrics === undefined
      ? {}
      : { getControllerMetrics: options.getControllerMetrics }),
    // Cleanup/persistence failure outranks a latched cap; the loop must classify the failure.
    getHostTermination: () => (failure === undefined ? termination : null),
    notifyController,
    readCaptureBuffer: () => capture,
    resetCaptureBuffer: () => {
      capture = [];
    },
    subscribe: () => () => undefined,
    isSealed: () => closed || options.fence.state === "finish_pending",
    subscribeSealed: (listener) => {
      sealedListeners.add(listener);
      return () => {
        sealedListeners.delete(listener);
      };
    },
    abortOwnedWork: close,
    async prompt(_text) {
      if (disposed) throw new Error("controller session is disposed");
      if (driver !== null) return driver;
      driver = (async () => {
        try {
          const payload = await runControllerPump(options, {
            signal: abort.signal,
            wait,
            audit,
            assertHealthy,
          });
          assertHealthy();
          capture = Object.freeze([{ toolName: "end" as const, args: payload }]);
          for (const listener of sealedListeners) listener();
        } catch (error) {
          const alreadyClosed = closed;
          if (!alreadyClosed) failure = error;
          await close();
          if (failure !== undefined) throw failure;
          // Operator abort/cost-cap is consumed by the loop before capture validation.
        }
      })();
      try {
        await driver;
      } finally {
        driver = null;
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      try {
        await close();
        await driver;
      } finally {
        options.fence.retire();
        auditOpen = false;
        closeSync(fd);
      }
    },
  };
}
