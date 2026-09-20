/** Per-child sandbox operation serialization — Issue #106 §4. */

/** One operation owns the gate until its complete settlement/finalization promise resolves. */
export type SandboxOperation<T> = (signal: AbortSignal) => Promise<T>;

/** Durable owner identity required when constructing one child operation gate. */
export interface SandboxOperationOwner {
  readonly runId: string;
  readonly childId: string;
}

/** Serialized owner gate; instances are independent by construction. */
export class SandboxOperationGate {
  private readonly queue: Array<QueuedOperation<unknown>> = [];
  private active: Promise<void> | undefined;
  private sealedCause: unknown;

  readonly owner: Readonly<SandboxOperationOwner>;

  constructor(owner: SandboxOperationOwner) {
    if (owner.runId.length === 0 || owner.childId.length === 0)
      throw new Error("sandbox operation gate owner identity must be non-empty");
    this.owner = Object.freeze({ runId: owner.runId, childId: owner.childId });
  }

  /** Queue one FIFO operation, or reject immediately when sealed/queued-aborted. */
  run<T>(signal: AbortSignal, operation: SandboxOperation<T>): Promise<T> {
    if (this.sealedCause !== undefined) return Promise.reject(this.sealedCause);
    if (signal.aborted)
      return Promise.reject(new Error("sandbox operation was aborted before start"));
    return new Promise<T>((resolve, reject) => {
      const entry: QueuedOperation<T> = { signal, operation, resolve, reject };
      const abort = (): void => {
        const index = this.queue.indexOf(entry as QueuedOperation<unknown>);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(new Error("sandbox operation was aborted before start"));
      };
      entry.abort = abort;
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(entry as QueuedOperation<unknown>);
      this.drain();
    });
  }

  /** Report whether a terminal ownership failure has sealed admission. */
  isSealed(): boolean {
    return this.sealedCause !== undefined;
  }

  /** Seal admission, preserving an active operation until its promise settles. */
  seal(cause: unknown = new Error("sandbox operation gate sealed")): void {
    if (this.sealedCause !== undefined) return;
    this.sealedCause = cause;
    for (const entry of this.queue.splice(0)) {
      if (entry.abort !== undefined) entry.signal.removeEventListener("abort", entry.abort);
      entry.reject(cause);
    }
  }

  /** Await active settlement, then report a seal as an unresolved ownership outcome. */
  async waitForIdle(): Promise<void> {
    while (this.active !== undefined) await this.active;
    if (this.sealedCause !== undefined) throw this.sealedCause;
  }

  private drain(): void {
    if (this.active !== undefined || this.sealedCause !== undefined) return;
    const entry = this.queue.shift();
    if (entry === undefined) return;
    if (entry.abort !== undefined) entry.signal.removeEventListener("abort", entry.abort);
    if (entry.signal.aborted) {
      entry.reject(new Error("sandbox operation was aborted before start"));
      this.drain();
      return;
    }
    this.active = Promise.resolve()
      .then(() => this.execute(entry))
      .finally(() => {
        this.active = undefined;
        this.drain();
      });
  }

  private async execute<T>(entry: QueuedOperation<T>): Promise<void> {
    try {
      if (this.sealedCause !== undefined) throw this.sealedCause;
      if (entry.signal.aborted) throw new Error("sandbox operation was aborted before start");
      entry.resolve(await entry.operation(entry.signal));
    } catch (cause) {
      entry.reject(cause);
    }
  }
}

interface QueuedOperation<T> {
  readonly signal: AbortSignal;
  readonly operation: SandboxOperation<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
  abort?: () => void;
}
