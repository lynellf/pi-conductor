import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
  compact,
  type ExtensionFactory,
  type SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { UsageRecord } from "../core/types.js";
import { addUsage, normalizeUsage, ZERO_USAGE } from "./cost.js";

/** A stream adapter accepted by Pi's public compaction function. */
export type CompactionStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** Host-neutral observation emitted after each completed compaction attempt. */
export interface CompactionObservation {
  readonly requestId: string;
  readonly beforeTip: string | null;
  readonly afterTip?: string;
  readonly beforeTokens: number;
  readonly usage: UsageRecord | null;
  readonly rawUsages: readonly (Usage | null)[];
  readonly error?: string;
}

/** Inputs needed to bind the shared compaction extension to one host session. */
export interface OrchestratorCompactionOptions {
  readonly requestId: () => string;
  readonly onStart: (start: {
    readonly requestId: string;
    readonly beforeTip: string | null;
    readonly beforeTokens: number;
  }) => void | Promise<void>;
  readonly onUsage: (chargeId: string, usage: Usage | null) => void;
  readonly onObservation: (observation: CompactionObservation) => void | Promise<void>;
  readonly streamFn?: CompactionStreamFn;
}

/** Error retained after a compaction hook failure so later requests cannot proceed. */
export class OrchestratorCompactionError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "OrchestratorCompactionError";
    this.cause = cause;
  }
}

/** Shared SDK/RPC compaction controller with sticky metering failures. */
export interface OrchestratorCompactionController {
  readonly extensionFactory: ExtensionFactory;
  getStickyError(): OrchestratorCompactionError | undefined;
  assertHealthy(): void;
  settle(): Promise<void>;
}

interface ActiveOperation {
  readonly requestId: string;
  readonly observation: () => CompactionObservation;
  readonly meterPromises: Promise<void>[];
  readonly abort: () => void;
  committed: boolean;
}

/** Create the extension factory that meters every public Pi compaction stream. */
export function createOrchestratorCompactionController(
  options: OrchestratorCompactionOptions,
): OrchestratorCompactionController {
  let stickyError: OrchestratorCompactionError | undefined;
  let abortCurrent = (): void => undefined;
  let active: ActiveOperation | undefined;

  const fail = (
    context: { abort(): void },
    message: string,
    cause?: unknown,
  ): OrchestratorCompactionError => {
    const error = new OrchestratorCompactionError(message, cause);
    stickyError ??= error;
    try {
      context.abort();
    } catch {
      // The original metering failure is the actionable error.
    }
    return error;
  };

  const extensionFactory: ExtensionFactory = (pi) => {
    pi.on("session_before_compact", async (event, context) => {
      abortCurrent = () => context.abort();
      if (stickyError !== undefined) return { cancel: true };
      let requestId: string;
      try {
        requestId = options.requestId();
      } catch (error) {
        fail(context, "orchestrator compaction request identity failed", error);
        return { cancel: true };
      }
      if (active !== undefined) {
        fail(context, "overlapping orchestrator compactions are unsupported");
        return { cancel: true };
      }
      const rawUsages: Array<Usage | null> = [];
      let knownUsage: UsageRecord | null = ZERO_USAGE;
      let callbackError: unknown;
      let streamOrdinal = 0;
      let beforeTip: string | null = null;
      let startAcknowledged = false;
      const recordUsage = (usage: Usage | null, ordinal: number): void => {
        if (usage !== null && !isValidUsage(usage)) {
          usage = null;
          callbackError = fail(context, "orchestrator compaction returned malformed usage");
        }
        rawUsages.push(usage);
        if (usage === null) {
          knownUsage = null;
        } else if (knownUsage !== null) {
          knownUsage = addUsage(knownUsage, normalizeUsage(usage));
        }
        try {
          options.onUsage(`${requestId}:${ordinal}`, usage);
        } catch (error) {
          callbackError = error;
          fail(context, "orchestrator compaction usage observation failed", error);
        }
      };
      const streamFn = meterStreams(
        options.streamFn ?? streamSimple,
        recordUsage,
        () => streamOrdinal++,
        (cause) => fail(context, "orchestrator compaction usage could not be observed", cause),
        (promise) => active?.meterPromises.push(promise),
      );
      const observation = (): CompactionObservation => ({
        requestId,
        beforeTip,
        beforeTokens: event.preparation.tokensBefore,
        usage: knownUsage,
        rawUsages: Object.freeze([...rawUsages]),
      });
      try {
        beforeTip = context.sessionManager.getLeafId();
        active = {
          requestId,
          observation,
          meterPromises: [],
          abort: context.abort,
          committed: false,
        };
        await options.onStart({
          requestId,
          beforeTip,
          beforeTokens: event.preparation.tokensBefore,
        });
        startAcknowledged = true;
        const model = context.model;
        if (model === undefined) throw new Error("no active model is available for compaction");
        const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) throw new Error(`compaction authentication unavailable: ${auth.error}`);
        const result = await compact(
          event.preparation,
          model,
          auth.apiKey,
          auth.headers,
          event.customInstructions,
          event.signal,
          pi.getThinkingLevel(),
          streamFn,
          auth.env,
        );
        await Promise.allSettled(active.meterPromises);
        if (callbackError !== undefined || stickyError !== undefined) {
          throw callbackError ?? stickyError;
        }
        active.committed = true;
        return { compaction: result };
      } catch (error) {
        if (active !== undefined) await Promise.allSettled(active.meterPromises);
        const failure = fail(
          context,
          "orchestrator compaction failed before metered completion",
          error,
        );
        if (startAcknowledged) {
          try {
            await options.onObservation({
              requestId,
              beforeTip,
              beforeTokens: event.preparation.tokensBefore,
              usage: knownUsage,
              rawUsages: Object.freeze([...rawUsages]),
              error: `${failure.message}: ${describeError(error)}`,
            });
          } catch {
            // Preserve the sticky failure and cancellation decision.
          }
        }
        active = undefined;
        return { cancel: true };
      }
    });
    pi.on("session_compact", async (event: SessionCompactEvent) => {
      const operation = active;
      if (operation === undefined || !operation.committed) return;
      try {
        await options.onObservation({
          ...operation.observation(),
          afterTip: event.compactionEntry.id,
        });
      } catch (error) {
        fail({ abort: abortCurrent }, "orchestrator compaction observation failed", error);
      }
      active = undefined;
    });
  };

  return {
    extensionFactory,
    getStickyError: () => stickyError,
    assertHealthy: () => {
      if (stickyError !== undefined) throw stickyError;
    },
    settle: async () => {
      const operation = active;
      if (operation === undefined) return;
      await Promise.allSettled(operation.meterPromises);
      if (active !== operation) return;
      const error = fail(
        { abort: operation.abort },
        "orchestrator compaction did not commit its result",
      );
      try {
        await options.onObservation({
          ...operation.observation(),
          error: `${error.message}: compaction result was not appended`,
        });
      } catch {
        // Preserve the sticky failure and cancellation decision.
      }
      active = undefined;
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function meterStreams(
  stream: CompactionStreamFn,
  record: (usage: Usage | null, ordinal: number) => void,
  nextOrdinal: () => number,
  onFailure: (cause?: unknown) => OrchestratorCompactionError,
  track: (promise: Promise<void>) => void,
): CompactionStreamFn {
  return (model, context, streamOptions) => {
    const ordinal = nextOrdinal();
    let result: AssistantMessageEventStream;
    try {
      result = stream(model, context, streamOptions);
    } catch (error) {
      record(null, ordinal);
      throw onFailure(error);
    }
    const settled = result
      .result()
      .then((message) => record(message.usage, ordinal))
      .catch((error) => {
        record(null, ordinal);
        onFailure(error);
      });
    track(settled);
    return result;
  };
}

function isValidUsage(usage: Usage): boolean {
  return [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalTokens,
    usage.cost.input,
    usage.cost.output,
    usage.cost.cacheRead,
    usage.cost.cacheWrite,
    usage.cost.total,
  ].every((value) => Number.isFinite(value) && value >= 0);
}
