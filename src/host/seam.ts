/**
 * Per-session seam state — spec §3, §11.3, §12.1.
 *
 * One `SessionSeam` per role session. The host creates it at `spawnRole`
 * time (Task 15) and closes over it from the `handoff`/`end` tool
 * factories (`src/host/tools.ts`). The orchestration loop reads it via
 * `RoleSession.readCaptureBuffer()` (Task 13) after `prompt()` resolves,
 * and the post-emission sealing wrapper (Task 15.5) reads `isSealed`.
 *
 * Owns three pieces of per-session state:
 *
 *   - **Capture buffer** (`EmissionCapture[]`): the machine-event
 *     tool calls recorded by this session, in order. Mutated only by
 *     the `handoff`/`end` tool wrappers. Read by the loop's
 *     `validateEmission` call (Phase 3, §3 rules 1–2, §11.3). The
 *     buffer is append-only and the public read returns a frozen view.
 *
 *   - **Sealed flag** (`isSealed`): set by the `handoff`/`end` tool
 *     on first valid capture (Task 14 → Task 15.5). While set, the
 *     host's wrapped built-in + custom tools short-circuit to error
 *     results WITHOUT invoking the underlying tool — preventing
 *     work-after-handoff from mutating the workspace after the role
 *     has declared its exit intent (§12.1). Per-session host state;
 *     never reducer state.
 *
 *   - **`reset()`**: clears both. Test-only helper; production code
 *     creates a fresh `SessionSeam` per role invocation. Listed as a
 *     method (not exported as a free function) so the seam stays the
 *     sole owner of its own state.
 *
 * No SDK runtime coupling — this module imports only the core types
 * it stores. The `defineTool` import lives in `tools.ts`, not here.
 */

import type { EmissionCapture } from "../seam/validate-emission.js";

export class SessionSeam {
  private readonly _captures: EmissionCapture[] = [];
  private _sealed = false;

  /**
   * Append a single capture to the buffer. Called by the
   * `handoff`/`end` tool wrappers on every invocation — for valid
   * first captures, for schema-invalid first captures, and for every
   * extra emission (the latter so the buffer length goes from 1 to
   * 2+, which `validateEmission` reads as `extra_emission`).
   *
   * Order is preserved; the loop relies on captures[0] being the
   * first machine-event call when the buffer has exactly one entry.
   */
  push(capture: EmissionCapture): void {
    this._captures.push(capture);
  }

  /**
   * Frozen view of the buffer in append order. The loop calls this
   * once per role session, after `prompt()` resolves, then feeds the
   * view into `validateEmission` (Phase 3) for the
   * ok / breach decision (§11.3).
   */
  read(): readonly EmissionCapture[] {
    return Object.freeze([...this._captures]);
  }

  /**
   * Flip the sealed flag. Idempotent. Called by `handoff`/`end` on
   * first valid capture (§12.1); the post-emission tool wrapper
   * (Task 15.5) reads `isSealed` to decide whether to short-circuit.
   */
  seal(): void {
    this._sealed = true;
  }

  /**
   * True once a valid machine-event has been recorded for this
   * session. The sealing wrapper (Task 15.5) refuses to execute any
   * side-effecting tool while this returns true.
   */
  get isSealed(): boolean {
    return this._sealed;
  }

  /**
   * Clear the capture buffer and sealed flag. Test-only helper —
   * production code creates a fresh `SessionSeam` per role invocation
   * rather than reusing one. Listed on the class so the seam remains
   * the sole owner of its state.
   */
  reset(): void {
    this._captures.length = 0;
    this._sealed = false;
  }
}
