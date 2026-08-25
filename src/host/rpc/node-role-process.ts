/** Package-local Pi process resolution and spawn helpers for the RPC role adapter. */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcChildProcess, RpcSpawnOptions } from "./protocol.js";
import { asRpcError, RpcAbortTimeoutError, RpcChildProcessError } from "./protocol.js";

/** Resolve the package-local pi CLI entry point rather than any host-global executable. */
export function resolvePackageLocalPiCli(): string {
  const packageJson = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url);
  if (packageJson === undefined) {
    throw new RpcChildProcessError("could not resolve the package-local Pi CLI");
  }
  return join(dirname(realpathSync(packageJson)), "dist", "cli.js");
}

/** Resolve the static extension beside this source module or its emitted `dist` counterpart. */
export function resolveMachineToolsExtensionPath(): string {
  const modulePath = fileURLToPath(import.meta.url);
  return join(dirname(modulePath), `machine-tools-extension${extname(modulePath)}`);
}

/** Spawn the package-local pi CLI under the current Node executable in RPC mode. */
export function spawnPackageLocalPi(options: RpcSpawnOptions): RpcChildProcess {
  return spawn(options.command, [...options.args], {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

const TERMINATE_GRACE_MS = 250;
const FORCE_TERMINATE_GRACE_MS = 250;

/** Own child exit observation and bounded graceful-to-forceful termination. */
export class RpcChildTerminator {
  private exited = false;
  private resolveExit: (() => void) | null = null;
  private readonly exit = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(private readonly child: RpcChildProcess) {}

  /** Mark an observed child exit before waking disposal waiters. */
  markExited(): void {
    this.exited = true;
    this.resolveExit?.();
    this.resolveExit = null;
  }

  /** Initiate best-effort graceful termination for startup failures. */
  terminate(): void {
    this.child.stdin.end?.();
    if (!this.hasExited()) this.sendSignal("SIGTERM");
  }

  /** Do not settle until a graceful signal or forceful fallback has led to child exit. */
  async terminateAndWait(): Promise<void> {
    this.child.stdin.end?.();
    if (this.hasExited()) return;

    const gracefulDelivered = this.sendSignal("SIGTERM");
    if (gracefulDelivered && (await this.waitForExit(TERMINATE_GRACE_MS))) return;
    if (this.hasExited()) return;

    const forceDelivered = this.sendSignal("SIGKILL");
    if (forceDelivered && (await this.waitForExit(FORCE_TERMINATE_GRACE_MS))) return;
    if (this.hasExited()) return;
    throw new RpcAbortTimeoutError();
  }

  private hasExited(): boolean {
    return (
      this.exited ||
      (this.child.exitCode !== null && this.child.exitCode !== undefined) ||
      (this.child.signalCode !== null && this.child.signalCode !== undefined)
    );
  }

  private sendSignal(signal: NodeJS.Signals): boolean {
    try {
      return this.child.kill(signal);
    } catch (error) {
      throw asRpcError(error);
    }
  }

  private async waitForExit(timeoutMs?: number): Promise<boolean> {
    if (this.hasExited()) return true;
    if (timeoutMs === undefined) {
      await this.exit;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), timeoutMs);
      void this.exit.then(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }
}
