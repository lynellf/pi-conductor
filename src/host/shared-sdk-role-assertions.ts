import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Assert a reopened trajectory retained its physical and model authority. */
export function assertExactResumedTrajectoryEnvironment(
  session: AgentSession,
  options: {
    readonly isTrajectory?: boolean;
    readonly model: Model<never> | undefined;
    readonly effort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    readonly expectedTrajectoryConversation?: { readonly id: string; readonly file: string };
  },
): void {
  const expectedConversation = options.expectedTrajectoryConversation;
  if (
    expectedConversation !== undefined &&
    (session.sessionId !== expectedConversation.id ||
      session.sessionFile !== expectedConversation.file)
  ) {
    throw new Error(
      `resumed trajectory conversation identity does not match its selector: expected ${expectedConversation.id} (${expectedConversation.file}), received ${session.sessionId} (${session.sessionFile})`,
    );
  }
  if (
    options.isTrajectory === true &&
    (options.model === undefined ||
      session.model?.provider !== options.model.provider ||
      session.model.id !== options.model.id ||
      session.thinkingLevel !== options.effort)
  ) {
    throw new Error("resumed trajectory target model or effort was not applied exactly");
  }
}
