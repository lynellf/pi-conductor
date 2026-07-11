/**
 * `ask_user` tool — spec §B.
 *
 * A normal, non-terminating tool that asks the user for input,
 * confirmation, or a selection. It is FSM-orthogonal: it writes
 * nothing to the session capture buffer and returns the dialog
 * answer directly to the model.
 *
 * ## Serialization (run fceb3964 hang)
 *
 * Two guards prevent the double-dialog hang where a role emits
 * multiple `ask_user` tool calls in one assistant turn and the
 * TUI's modal dialog races:
 *
 * 1. `executionMode: "sequential"` — SDK-level metadata. Custom
 *    tools default to parallel in the pi runtime; modal dialogs
 *    must not race, so we declare sequential. (spec §B; run
 *    fceb3964 evidence: two `select` calls in one assistant
 *    message, one orphaned → `prompt()` hung until abort.)
 * 2. In-tool promise-chain mutex — belt-and-suspenders guard for
 *    non-SDK callers (unit tests call `execute` directly, forked
 *    CLI UI paths, etc.). A simple per-instance async lock
 *    serializes all `execute` invocations regardless of how the
 *    dispatch layer schedules them.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { AskUserUnavailableError } from "./errors.js";

/**
 * Flat parameter schema — spec §B / Issue #1.
 *
 * Uses `Type.Unsafe` for the `kind` enum to emit a portable
 * `{type:"string", enum:[…]}` JSON-Schema (no `anyOf`/`const`)
 * accepted by all model providers including Google Gemini.
 */
export const askUserArgsSchema = Type.Object(
  {
    kind: Type.Unsafe({
      type: "string",
      enum: ["input", "confirm", "select"],
      description:
        "Dialog control: input for free-form text, confirm for yes/no, select for one option.",
    }),
    prompt: Type.String({
      minLength: 1,
      description: "The question shown to the user.",
    }),
    options: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Choices for select only; omit this field for input and confirm.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description: "Ask a user for free-form text, a yes/no answer, or one supplied choice.",
    examples: [
      { kind: "input", prompt: "What should I clarify?" },
      { kind: "confirm", prompt: "Proceed with the migration?" },
      { kind: "select", prompt: "Which plan?", options: ["A", "B"] },
    ],
  },
);

type AskUserKind = "input" | "confirm" | "select";

/**
 * Hand-typed interface mirroring the flat schema so the `execute`
 * discriminated switch is narrow. Allowed by AGENTS.md invariant #9
 * because `ask_user` is a regular non-emission tool.
 */
interface AskUserArgs {
  readonly kind: AskUserKind;
  readonly prompt: string;
  readonly options?: string[];
}

interface AskUserToolDetailsInput {
  readonly kind: "input";
  readonly answer: string | undefined;
}

interface AskUserToolDetailsConfirm {
  readonly kind: "confirm";
  readonly answer: boolean;
}

interface AskUserToolDetailsSelect {
  readonly kind: "select";
  readonly answer: string | undefined;
}

type AskUserToolDetails =
  | AskUserToolDetailsInput
  | AskUserToolDetailsConfirm
  | AskUserToolDetailsSelect;

function formatAnswer(kind: AskUserKind, answer: string | boolean | undefined): string {
  if (kind === "confirm") {
    return String(answer);
  }
  if (kind === "input") {
    return (answer as string | undefined) ?? "(no answer)";
  }
  return (answer as string | undefined) ?? "(no selection)";
}

function validateAskUserArgs(params: AskUserArgs): void {
  if (params.kind === "select") {
    if (params.options === undefined || params.options.length < 1) {
      throw new Error("ask_user: 'select' kind requires a non-empty 'options' array");
    }
    return;
  }

  if (params.options !== undefined) {
    throw new Error(
      `ask_user: '${params.kind}' kind does not accept 'options'; use 'select' for multiple-choice questions`,
    );
  }
}

/**
 * Build the `ask_user` tool (spec §B). The host wires one instance
 * per role session, and the tool reads the UI from the execution
 * context so no ambient singleton is needed.
 */
export function createAskUserTool(): ToolDefinition<typeof askUserArgsSchema, AskUserToolDetails> {
  // ── In-tool promise-chain mutex (spec §B, run fceb3964). ────────
  // Each invocation links the next waiter onto `tail` and awaits
  // its predecessor. The `finally` block releases the lock even
  // on rejection (abort, unknown kind throw, etc.) so a failed
  // dialog never leaks the mutex. Belt-and-suspenders on top of
  // `executionMode: "sequential"` (which the SDK dispatcher reads;
  // this mutex guards direct-execute paths like unit tests and
  // forked CLI UIs).
  let tail: Promise<void> = Promise.resolve();

  return defineTool({
    name: "ask_user",
    label: "Ask user",
    description: "Ask the user a clarifying question and return the answer.",
    parameters: askUserArgsSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      // `Type.Unsafe` intentionally emits a portable enum schema but its
      // inferred kind is unknown; the SDK has already validated this shape.
      const args = params as AskUserArgs;
      validateAskUserArgs(args);
      if (!ctx.hasUI) {
        throw new AskUserUnavailableError(ctx.mode);
      }

      // ── Acquire the per-tool-instance mutex ─────────────────
      let release!: () => void;
      const held = new Promise<void>((res) => (release = res));
      const prev = tail;
      tail = held; // link: later callers await `prev`
      await prev; // acquire: wait for prior holder's release

      try {
        const dialogOptions = signal === undefined ? undefined : { signal };

        switch (args.kind) {
          case "input": {
            const answer = await ctx.ui.input(args.prompt, undefined, dialogOptions);
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatAnswer(args.kind, answer),
                },
              ],
              details: {
                kind: "input",
                answer,
              } satisfies AskUserToolDetailsInput,
              terminate: false,
            };
          }
          case "confirm": {
            const answer = await ctx.ui.confirm("Ask user", args.prompt, dialogOptions);
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatAnswer(args.kind, answer),
                },
              ],
              details: {
                kind: "confirm",
                answer,
              } satisfies AskUserToolDetailsConfirm,
              terminate: false,
            };
          }
          case "select": {
            if (args.options === undefined || args.options.length < 1) {
              throw new Error("ask_user: 'select' kind requires a non-empty 'options' array");
            }
            const answer = await ctx.ui.select(args.prompt, args.options, dialogOptions);
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatAnswer(args.kind, answer),
                },
              ],
              details: {
                kind: "select",
                answer,
              } satisfies AskUserToolDetailsSelect,
              terminate: false,
            };
          }
          default:
            throw new Error(`ask_user: unknown kind '${args.kind}'`);
        }
      } finally {
        release(); // always unblock the next waiter
      }
    },
  });
}
