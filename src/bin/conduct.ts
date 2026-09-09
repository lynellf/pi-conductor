#!/usr/bin/env node
/** CLI bootstrap: supply host-owned Pi peers before loading the SDK host (§12). */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CliDeps } from "./cli-main.js";
import { registerCliPeerResolution } from "./cli-peer-resolution.js";

export type { CliDeps, CliJsonResult } from "./cli-main.js";

/** Preserve the injectable CLI API without installing process-wide hooks on import. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const hooks = registerCliPeerResolution();
  try {
    const cli = await import("./cli-main.js");
    return await cli.runCli(argv, deps);
  } finally {
    hooks.deregister();
  }
}

// npm's bin is a symlink; compare canonical paths so it still invokes main().
const isEntrypoint = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    // Embedders may supply a synthetic argv[1]; importing the API must still work.
    return false;
  }
})();

if (isEntrypoint) {
  try {
    registerCliPeerResolution();
    // Static imports would be linked before hooks are registered.
    // https://nodejs.org/download/release/v22.18.0/docs/api/module.html#customization-hooks
    const { main } = await import("./cli-main.js");
    process.exit(await main());
  } catch (error) {
    console.error(`pi-conductor: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
