/** Graceful process-signal handling for active conduct CLI runs (issue #34). */

/** Signals handled while a CLI-owned run is active. */
export type CliSignal = "SIGINT" | "SIGTERM";

/** Injectable signal subscription boundary used by the CLI and its tests. */
export interface CliSignalSource {
  on(signal: CliSignal, listener: (signal: CliSignal) => void): void;
  off(signal: CliSignal, listener: (signal: CliSignal) => void): void;
}

interface AbortableRun {
  abort(reason: string): Promise<void>;
}

/** Process-backed signal source used by the production CLI entrypoint. */
export const processSignalSource: CliSignalSource = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};

/** Install first-signal abort and second-signal immediate-exit behavior. */
export function installCliSignalHandlers(opts: {
  readonly handle: AbortableRun;
  readonly source: CliSignalSource;
  readonly exit: (code: number) => void;
  readonly onAbortError: (error: unknown, signal: CliSignal) => void;
}): () => void {
  let received = 0;
  const handler = (signal: CliSignal): void => {
    received += 1;
    if (received === 1) {
      void opts.handle
        .abort(`conduct received ${signal}`)
        .catch((error: unknown) => opts.onAbortError(error, signal));
      return;
    }
    opts.exit(signal === "SIGINT" ? 130 : 143);
  };

  opts.source.on("SIGINT", handler);
  opts.source.on("SIGTERM", handler);

  return () => {
    opts.source.off("SIGINT", handler);
    opts.source.off("SIGTERM", handler);
  };
}
