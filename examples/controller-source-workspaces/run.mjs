#!/usr/bin/env node
// Run the no-model source-workspace example through the production host
// supervisor. The real test owns Bubblewrap admission, runtime pinning,
// source preparation, validator execution, and durable evidence.
import { spawn } from "node:child_process";

const required = [
  "PI_CONDUCTOR_BWRAP",
  "PI_CONDUCTOR_BWRAP_RUNTIME",
  "PI_CONDUCTOR_BWRAP_SHA256",
];
const missing = required.filter((name) => process.env[name] === undefined);
if (missing.length > 0) {
  throw new Error(`set approved Bubblewrap inputs before running the example: ${missing.join(", ")}`);
}

const child = spawn(
  process.env.PNPM_BIN ?? "pnpm",
  [
    "vitest",
    "run",
    "--config",
    "vitest.sandbox.config.ts",
    "tests/host/bubblewrap-source-workspaces.real.ts",
    "tests/host/bubblewrap-source-workers.real.ts",
    "--reporter=verbose",
  ],
  { stdio: "inherit", env: process.env },
);
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
