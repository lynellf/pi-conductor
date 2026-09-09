/** Parsed `/conduct:resume` arguments. */
export interface ResumeCommandArgs {
  readonly runId: string;
  readonly resetOrchestratorContext: boolean;
}

/** Parse the strict resume command grammar, rejecting unknown or duplicate flags. */
export function parseResumeCommandArgs(args: string): ResumeCommandArgs {
  const tokens = args.trim().length === 0 ? [] : args.trim().split(/\s+/u);
  let runId: string | undefined;
  let resetOrchestratorContext = false;
  for (const token of tokens) {
    if (token === "--reset-orchestrator-context") {
      if (resetOrchestratorContext) throw new Error("duplicate --reset-orchestrator-context flag");
      resetOrchestratorContext = true;
      continue;
    }
    if (token.startsWith("-")) throw new Error(`unknown resume flag '${token}'`);
    if (runId !== undefined) throw new Error("resume accepts exactly one run_id");
    runId = token;
  }
  if (runId === undefined)
    throw new Error("Usage: /conduct:resume [--reset-orchestrator-context] <run_id>");
  return { runId, resetOrchestratorContext };
}
