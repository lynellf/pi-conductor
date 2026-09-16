import { ToolExecutionError } from "./tool-execution-contract.js";

/** Tracks owned executable attempts so host shutdown can await their cleanup. */
export class ExecutionAttemptTracker {
  private readonly aborts = new Set<AbortController>();
  private readonly rejects = new Set<(reason: unknown) => void>();
  private readonly work = new Set<Promise<unknown>>();
  private closeWork: Promise<void> | undefined;

  track<T>(work: Promise<T>): Promise<T> {
    this.work.add(work);
    void work.finally(() => this.work.delete(work)).catch(() => undefined);
    return work;
  }

  addAbort(abort: AbortController): void {
    this.aborts.add(abort);
  }

  deleteAbort(abort: AbortController): void {
    this.aborts.delete(abort);
  }

  addReject(reject: (reason: unknown) => void): void {
    this.rejects.add(reject);
  }

  deleteReject(reject: (reason: unknown) => void): void {
    this.rejects.delete(reject);
  }

  /** Abort and wake every active attempt, then surface only unrecoverable results. */
  close(): Promise<void> {
    if (this.closeWork !== undefined) return this.closeWork;
    for (const abort of this.aborts) abort.abort();
    for (const reject of this.rejects) reject(new Error("controller closed"));
    this.closeWork = Promise.allSettled([...this.work]).then((results) => {
      const failed = results.find(
        (result) => result.status === "rejected" && isUnrecoverable(result.reason),
      );
      if (failed?.status === "rejected") throw failed.reason;
    });
    return this.closeWork;
  }

  abort(reason: unknown = new Error("controller closed")): void {
    for (const abort of this.aborts) abort.abort();
    for (const reject of this.rejects) reject(reason);
  }
}

function isUnrecoverable(reason: unknown): boolean {
  return (
    reason instanceof ToolExecutionError &&
    (reason.code === "tool_persistence_ambiguous" || reason.cleanup === "unconfirmed")
  );
}
