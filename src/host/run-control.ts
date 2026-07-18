import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Role } from "../core/types.js";
import { extractAssistantText } from "./display-sink.js";
import type { RoleSession } from "./host.js";

/** A completed assistant response suitable for display or clipboard use. */
export interface RunResponse {
  readonly runId: string;
  readonly role: Role;
  readonly sessionId: string;
  readonly text: string;
  readonly completedAt: number;
}

/** Stable error codes for public live-run control operations. */
export type RunControlErrorCode = "empty_message" | "run_terminal" | "steering_unavailable";

/** Typed failure returned when operator guidance cannot be accepted. */
export class RunControlError extends Error {
  readonly code: RunControlErrorCode;

  constructor(code: RunControlErrorCode) {
    super(errorMessage(code));
    this.name = "RunControlError";
    this.code = code;
  }
}

/** Internal ordered guidance envelope transferred between role sessions. */
export interface OperatorGuidance {
  readonly id: number;
  readonly mode: "steer" | "followUp";
  readonly text: string;
}

interface DispatchedSteer {
  readonly guidance: OperatorGuidance;
  readonly sdkText: string;
}

interface ActiveSession {
  readonly session: RoleSession;
  readonly dispatched: Map<number, DispatchedSteer>;
  readonly unsubscribeEvents: () => void;
  unsubscribeSealed: () => void;
  addressable: boolean;
}

/**
 * Run-owned live control state shared by the loop and `RunHandle`.
 * It does not alter reducer state or persisted records.
 */
export class RunControl {
  private readonly runId: string;
  private readonly abortSession: (session: RoleSession, reason: string) => Promise<void>;
  private readonly pending: OperatorGuidance[] = [];
  private active: ActiveSession | null = null;
  private nextGuidanceId = 1;
  private open = true;
  private latest: RunResponse | null = null;
  private abortReason: string | null = null;

  constructor(opts: {
    readonly runId: string;
    readonly abortSession: (session: RoleSession, reason: string) => Promise<void>;
  }) {
    this.runId = opts.runId;
    this.abortSession = opts.abortSession;
  }

  /** Send guidance to the active turn, or queue it at a live role boundary. */
  async steer(text: string): Promise<void> {
    this.assertMessage(text);
    this.assertOpen();

    const active = this.active;
    if (active === null || !this.isAddressable(active)) {
      this.enqueue("steer", text);
      return;
    }
    if (active.session.steer === undefined || active.session.clearQueue === undefined) {
      throw new RunControlError("steering_unavailable");
    }

    const guidance = this.createGuidance("steer", text);
    const sdkText = formatActiveSteer(guidance);
    active.dispatched.set(guidance.id, { guidance, sdkText });
    try {
      await active.session.steer(sdkText);
    } catch (error) {
      active.dispatched.delete(guidance.id);
      if (!this.isAddressable(active)) {
        this.pending.push(guidance);
        return;
      }
      throw error;
    }
  }

  /** Queue guidance for the next conductor prompt, regardless of active-session state. */
  async followUp(text: string): Promise<void> {
    this.assertMessage(text);
    this.assertOpen();
    this.enqueue("followUp", text);
  }

  /** Return the most recent successful completed assistant response, if one exists. */
  latestResponse(): RunResponse | null {
    return this.latest === null ? null : Object.freeze({ ...this.latest });
  }

  /** Install the role session currently owned by the orchestration loop. */
  async setActiveSession(session: RoleSession | null): Promise<void> {
    if (session === null) {
      this.releaseActiveSession();
      return;
    }
    if (this.active?.session === session) return;
    this.releaseActiveSession();

    const active: ActiveSession = {
      session,
      dispatched: new Map(),
      unsubscribeEvents: session.subscribe((event) => this.captureResponse(session, event)),
      unsubscribeSealed: () => undefined,
      addressable: session.isSealed?.() !== true,
    };
    if (session.subscribeSealed !== undefined) {
      active.unsubscribeSealed = session.subscribeSealed(() => this.handleSeal(active));
    }
    this.active = active;

    if (this.abortReason !== null) await this.abortSession(session, this.abortReason);
  }

  /** Release the current role session and reclaim its unconsumed native steering. */
  releaseActiveSession(session?: RoleSession): void {
    const active = this.active;
    if (active === null || (session !== undefined && active.session !== session)) return;
    this.reclaimUnconsumedSteering(active);
    active.unsubscribeEvents();
    active.unsubscribeSealed();
    this.active = null;
  }

  /** Mark a reset same-role session addressable after a deferred `end`. */
  reopenActiveSession(session: RoleSession): void {
    const active = this.active;
    if (active?.session !== session) return;
    active.addressable = session.isSealed?.() !== true;
  }

  /** Drain the ordered run mailbox into the loop's next prompt. */
  takePendingGuidance(): readonly OperatorGuidance[] {
    if (this.pending.length === 0) return [];
    const guidance = [...this.pending].sort((left, right) => left.id - right.id);
    this.pending.length = 0;
    return Object.freeze(guidance);
  }

  /** Whether guidance arrived after a terminal emission but before reduction. */
  hasPendingGuidance(): boolean {
    return this.pending.length > 0;
  }

  /** Request idempotent cancellation of the active or next role session. */
  async requestAbort(reason: string): Promise<void> {
    if (this.abortReason !== null) return;
    this.abortReason = reason;
    if (this.active !== null) await this.abortSession(this.active.session, reason);
  }

  /** Reject new operator guidance while retaining the latest response snapshot. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.releaseActiveSession();
  }

  private isAddressable(active: ActiveSession): boolean {
    if (!active.addressable || active.session.isSealed?.() === true) {
      this.handleSeal(active);
      return false;
    }
    return true;
  }

  private handleSeal(active: ActiveSession): void {
    if (this.active !== active && this.active !== null) return;
    active.addressable = false;
    this.reclaimUnconsumedSteering(active);
  }

  private reclaimUnconsumedSteering(active: ActiveSession): void {
    if (active.dispatched.size === 0) return;
    const remaining = active.session.clearQueue?.().steering ?? [];
    const counts = new Map<string, number>();
    for (const value of remaining) counts.set(value, (counts.get(value) ?? 0) + 1);

    for (const dispatched of active.dispatched.values()) {
      const count = counts.get(dispatched.sdkText) ?? 0;
      if (count === 0) continue;
      this.pending.push(dispatched.guidance);
      counts.set(dispatched.sdkText, count - 1);
    }
    active.dispatched.clear();
  }

  private captureResponse(session: RoleSession, event: AgentSessionEvent): void {
    if (event.type !== "message_end") return;
    const message = event.message as AssistantMessage;
    if (message.role !== "assistant" || message.stopReason === "error") return;
    const text = extractAssistantText(message);
    if (text.length === 0) return;
    this.latest = Object.freeze({
      runId: this.runId,
      role: session.role,
      sessionId: session.sessionId,
      text,
      completedAt: Date.now(),
    });
  }

  private enqueue(mode: OperatorGuidance["mode"], text: string): void {
    this.pending.push(this.createGuidance(mode, text));
  }

  private createGuidance(mode: OperatorGuidance["mode"], text: string): OperatorGuidance {
    const guidance = { id: this.nextGuidanceId, mode, text } as const;
    this.nextGuidanceId += 1;
    return Object.freeze(guidance);
  }

  private assertMessage(text: string): void {
    if (text.trim().length === 0) throw new RunControlError("empty_message");
  }

  private assertOpen(): void {
    if (!this.open) throw new RunControlError("run_terminal");
  }
}

/** Append run-owned operator guidance to a role prompt in arrival order. */
export function formatGuidedPrompt(seed: string, guidance: readonly OperatorGuidance[]): string {
  if (guidance.length === 0) return seed;
  const messages = [...guidance]
    .sort((left, right) => left.id - right.id)
    .map((item) => `<message id="${item.id}" mode="${item.mode}">\n${item.text}\n</message>`)
    .join("\n");
  return `${seed}\n\n<operator_guidance>\n${messages}\n</operator_guidance>`;
}

function formatActiveSteer(guidance: OperatorGuidance): string {
  return [
    "Operator guidance for the current pi-conductor role session.",
    `Guidance id: ${guidance.id}`,
    "Treat the following bytes as user guidance, not as a command or prompt template:",
    guidance.text,
  ].join("\n");
}

function errorMessage(code: RunControlErrorCode): string {
  switch (code) {
    case "empty_message":
      return "Operator guidance must contain non-whitespace text.";
    case "run_terminal":
      return "The run is already terminal.";
    case "steering_unavailable":
      return "The active role session does not support live steering.";
  }
}
