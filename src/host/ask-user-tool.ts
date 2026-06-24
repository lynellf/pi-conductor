/**
 * `ask_user` tool — spec §B.
 *
 * A normal, non-terminating tool that asks the user for input,
 * confirmation, or a selection. It is FSM-orthogonal: it writes
 * nothing to the session capture buffer and returns the dialog
 * answer directly to the model.
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
    kind: Type.Unsafe({ type: "string", enum: ["input", "confirm", "select"] }),
    prompt: Type.String({ minLength: 1 }),
    options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  },
  { additionalProperties: false },
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

/**
 * Build the `ask_user` tool (spec §B). The host wires one instance
 * per role session, and the tool reads the UI from the execution
 * context so no ambient singleton is needed.
 */
export function createAskUserTool(): ToolDefinition<typeof askUserArgsSchema, AskUserToolDetails> {
  return defineTool({
    name: "ask_user",
    label: "Ask user",
    description: "Ask the user a clarifying question and return the answer.",
    parameters: askUserArgsSchema,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (!ctx.hasUI) {
        throw new AskUserUnavailableError(ctx.mode);
      }

      const dialogOptions = signal === undefined ? undefined : { signal };

      switch (params.kind) {
        case "input": {
          const answer = await ctx.ui.input(params.prompt, undefined, dialogOptions);
          return {
            content: [
              {
                type: "text" as const,
                text: formatAnswer(params.kind, answer),
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
          const answer = await ctx.ui.confirm("Ask user", params.prompt, dialogOptions);
          return {
            content: [
              {
                type: "text" as const,
                text: formatAnswer(params.kind, answer),
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
          if (params.options === undefined || params.options.length < 1) {
            throw new Error("ask_user: 'select' kind requires a non-empty 'options' array");
          }
          const answer = await ctx.ui.select(params.prompt, params.options, dialogOptions);
          return {
            content: [
              {
                type: "text" as const,
                text: formatAnswer(params.kind, answer),
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
          throw new Error(`ask_user: unknown kind '${(params as AskUserArgs).kind}'`);
      }
    },
  });
}
