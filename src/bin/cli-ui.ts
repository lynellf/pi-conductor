/** CLI UI adapters for interactive and noninteractive conduct runs (issue #34). */

import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { AskUserUnavailableError } from "../host/errors.js";

/** Build the stdin-backed UI used by legacy interactive CLI runs. */
export function createCliUiContext(input: Readable, output: Writable): ExtensionUIContext {
  const ask = async (prompt: string): Promise<string> => {
    const rl = createInterface({ input, output });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  };

  return {
    select: async (title: string, options: string[]) => {
      output.write(`${title}\n`);
      for (const [index, option] of options.entries()) {
        output.write(`${index + 1}. ${option}\n`);
      }
      const answer = (await ask("> ")).trim();
      const selectedIndex = Number.parseInt(answer, 10);
      if (
        Number.isInteger(selectedIndex) &&
        selectedIndex >= 1 &&
        selectedIndex <= options.length
      ) {
        return options[selectedIndex - 1];
      }
      return options.find((option: string) => option === answer);
    },
    confirm: async (title: string, message: string) => {
      output.write(`${title}: ${message}\n`);
      const answer = (await ask("[y/N] ")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
    input: (title: string, placeholder?: string) =>
      ask(`${title}${placeholder ? ` (${placeholder})` : ""}: `),
    notify: (message: string, type = "info") => output.write(`[${type}] ${message}\n`),
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
  } as unknown as ExtensionUIContext;
}

/** Build a UI whose dialog methods fail without touching stdin. */
export function createNonInteractiveUiContext(): ExtensionUIContext {
  const unavailable = async (): Promise<never> => {
    throw new AskUserUnavailableError("non-interactive");
  };

  return {
    select: unavailable,
    confirm: unavailable,
    input: unavailable,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
  } as unknown as ExtensionUIContext;
}
