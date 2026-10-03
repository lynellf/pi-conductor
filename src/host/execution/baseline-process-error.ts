/** Portable foreground evidence remains separate from enhanced cleanup (§5). */
import type { BaselineForegroundStatus } from "../../persistence/baseline-execution.js";
import {
  SupervisedProcessError,
  type SupervisedProcessFailureCode,
} from "./supervised-process-contract.js";

/** A baseline process failure reports only whether its foreground handle settled. */
export class BaselineProcessError extends SupervisedProcessError {
  constructor(
    code: SupervisedProcessFailureCode,
    message: string,
    foregroundStatus: BaselineForegroundStatus,
    elapsedMs: number,
    private readonly observeForeground: () => BaselineForegroundStatus = () => foregroundStatus,
  ) {
    super(
      code,
      message,
      foregroundStatus === "not-started" ? "not-started" : "unconfirmed",
      null,
      elapsedMs,
    );
    this.name = "BaselineProcessError";
  }

  /** Re-read this same child's late close; never reuse another child's evidence. */
  get foregroundStatus(): BaselineForegroundStatus {
    return this.observeForeground();
  }
}
