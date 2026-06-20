/**
 * `ask_user` tool — spec §B.
 *
 * A normal, non-terminating tool that asks the user for input,
 * confirmation, or a selection. It is FSM-orthogonal: it writes
 * nothing to the session capture buffer and returns the dialog
 * answer directly to the model.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import { AskUserUnavailableError } from "./errors.js";

const askUserInputSchema = Type.Object(
  {
    kind: Type.Literal("input"),
    prompt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const askUserConfirmSchema = Type.Object(
  {
    kind: Type.Literal("confirm"),
    prompt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const askUserSelectSchema = Type.Object(
  {
    kind: Type.Literal("select"),
    prompt: Type.String({ minLength: 1 }),
    options: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  },
  { additionalProperties: false },
);

const askUserArgsSchema = Type.Union([
  askUserInputSchema,
  askUserConfirmSchema,
  askUserSelectSchema,
]);

type AskUserArgs = Static<typeof askUserArgsSchema>;

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

function formatAnswer(kind: AskUserArgs["kind"], answer: string | boolean | undefined): string {
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
      }
    },
  });
}
