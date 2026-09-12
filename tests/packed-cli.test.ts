import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const checkout = fileURLToPath(new URL("../", import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), "pi-conductor-packed-cli-"));
const packageRoot = join(sandbox, "pi-user/npm/node_modules/pi-conductor");
const entry = join(packageRoot, "dist/bin/conduct.js");
const bin = join(sandbox, "bin");
const piRoot =
  process.env.CONDUCTOR_SMOKE_PI_ROOT ??
  realpathSync(join(checkout, "node_modules/@earendil-works/pi-coding-agent"));

beforeAll(() => {
  mkdirSync(join(packageRoot, "node_modules"), { recursive: true });
  mkdirSync(bin);
  execFileSync("pnpm", ["pack", "--pack-destination", sandbox], {
    cwd: checkout,
    stdio: "pipe",
    timeout: 120_000,
  });
  const archive = readdirSync(sandbox).find((name) => name.endsWith(".tgz"));
  if (archive === undefined) throw new Error("pnpm pack did not produce an archive");
  execFileSync("tar", ["-xzf", join(sandbox, archive), "--strip-components=1", "-C", packageRoot]);
  for (const dependency of ["diff", "yaml"]) {
    symlinkSync(
      join(checkout, "node_modules", dependency),
      join(packageRoot, "node_modules", dependency),
    );
  }
  // Match npm's executable symlink, including the newer bundled CLI location.
  const metadata = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")) as {
    bin: { pi: string };
  };
  symlinkSync(join(piRoot, metadata.bin.pi), join(bin, "pi"));
  symlinkSync(entry, join(bin, "conduct"));
}, 180_000);

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function invoke(args: string[] = [], overrides: NodeJS.ProcessEnv = {}, invoked = entry) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin,
    PI_CODING_AGENT_DIR: join(sandbox, "pi-user"),
    ...overrides,
  };
  if (overrides.PI_PACKAGE_DIR === undefined) delete env.PI_PACKAGE_DIR;
  return spawnSync(process.env.CONDUCTOR_SMOKE_NODE ?? process.execPath, [invoked, ...args], {
    cwd: sandbox,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

it("starts a packed CLI using the Pi installation on PATH without local peers", () => {
  const result = invoke();
  expect({ status: result.status, stderr: result.stderr }).toEqual({
    status: 2,
    stderr: expect.stringContaining("Usage: conduct"),
  });
});

it("reaches manifest validation using an explicit SDK directory", () => {
  const result = invoke(["missing.yaml", "test goal"], { PI_PACKAGE_DIR: piRoot, PATH: "" });
  expect({ status: result.status, stderr: result.stderr }).toEqual({
    status: 3,
    stderr: expect.stringContaining("Manifest not found: missing.yaml"),
  });
});

it("executes the CLI through an npm-style bin symlink", () => {
  const result = invoke([], {}, join(bin, "conduct"));
  expect({ status: result.status, stderr: result.stderr }).toEqual({
    status: 2,
    stderr: expect.stringContaining("Usage: conduct"),
  });
});

it("allows importing the CLI API when the host's argv is not an executable path", () => {
  const script = `
process.argv[1] = 'programmatic-host';
const { runCli } = await import(${JSON.stringify(entry)});
console.log(typeof runCli);
`;
  const result = invoke(["--eval", script], { PATH: "" }, "--input-type=module");
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 0,
    stdout: "function\n",
    stderr: "",
  });
});

it("runs the public CLI API with injected dependencies in a managed install", () => {
  const probe = join(packageRoot, "api-probe.mjs");
  writeFileSync(
    probe,
    `
import { runCli } from 'pi-conductor/bin/conduct';
const messages = [];
const exits = [];
const code = await runCli([], {
  startRun: () => { throw new Error('unexpected orchestration'); },
  modelRegistry: {},
  console: { error: message => messages.push(message) },
  exit: code => exits.push(code),
  cwd: process.cwd(),
});
console.log(JSON.stringify({ code, messages, exits }));
`,
  );
  const result = invoke([], {}, probe);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    code: 2,
    messages: [expect.stringContaining("Usage: conduct")],
    exits: [2],
  });
});

it.each([
  ["done", 0, "done"],
  ["session_failed", 1, "tool_cleanup_unconfirmed"],
  ["aborted", 0, "user_aborted"],
] as const)("runs the built conduct entrypoint with terminal reason %s", (exitReason, expectedStatus, failureReason) => {
  const manifest = join(sandbox, `entrypoint-${exitReason}.yaml`);
  writeFileSync(manifest, "version: 1\nroles: []\n", "utf8");
  const stub = join(packageRoot, `entrypoint-index-${exitReason}.mjs`);
  writeFileSync(
    stub,
    `
const reason = ${JSON.stringify(exitReason)};
export const createProductionHost = () => { throw new Error('host factory should not run'); };
export const startRun = async () => ({
  runId: 'packed-entrypoint-status',
  loadedManifest: { warnings: [] },
  completion: async () => ({ finalCheckpoint: { current_role: reason === 'done' ? 'done' : 'orchestrator' }, exitReason: reason }),
  latestResponse: () => null,
  runStats: () => ({ state: reason === 'done' ? 'done' : 'orchestrator', exitReason: reason === 'session_failed' ? 'running' : reason, recordsCount: 4, failureReason: ${JSON.stringify(failureReason)} }),
});
`,
  );
  const preload = join(packageRoot, `entrypoint-preload-${exitReason}.mjs`);
  writeFileSync(
    preload,
    `
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '../index.js' && context.parentURL?.endsWith('/dist/bin/cli-main.js')) {
    return { url: ${JSON.stringify(pathToFileURL(stub).href)}, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
`,
  );
  const result = invoke(["--non-interactive", "--json", manifest, "goal"], {
    NODE_OPTIONS: `--import ${preload}`,
  });
  expect(result.status, result.stderr).toBe(expectedStatus);
  const document = JSON.parse(result.stdout) as {
    exit_reason: string;
    run_stats: { exitReason: string };
  };
  expect(document.exit_reason).toBe(exitReason);
  expect(document.run_stats.exitReason).toBe(exitReason);
});

it("explains how to supply the SDK when there are no peers or Pi on PATH", () => {
  const result = invoke([], { PATH: "" });
  expect({ status: result.status, stderr: result.stderr }).toEqual({
    status: 1,
    stderr: expect.stringContaining("set PI_PACKAGE_DIR to its package directory"),
  });
});

it("rejects an invalid explicit SDK instead of selecting Pi on PATH", () => {
  const result = invoke([], { PI_PACKAGE_DIR: packageRoot });
  expect({ status: result.status, stderr: result.stderr }).toEqual({
    status: 1,
    stderr: expect.stringContaining(
      "Invalid PI_PACKAGE_DIR: Expected @earendil-works/pi-coding-agent",
    ),
  });
});

it("gives repair guidance for an SDK package with a missing exported entrypoint", () => {
  const brokenSdk = join(sandbox, "broken-sdk");
  mkdirSync(brokenSdk);
  writeFileSync(
    join(brokenSdk, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      exports: { ".": { import: "./missing.js" } },
    }),
  );
  const result = invoke([], { PI_PACKAGE_DIR: brokenSdk });
  expect({ status: result.status, stderr: result.stderr }).toEqual({
    status: 1,
    stderr: expect.stringContaining("set PI_PACKAGE_DIR to its package directory"),
  });
});

it("resolves peer subpaths to the host tree and leaves other imports alone", () => {
  const probe = join(packageRoot, "dist/peer-probe.js");
  writeFileSync(
    probe,
    `
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { parse } from 'yaml';
export const result = {
  valid: Value.Check(Type.String(), parse('hello')),
  stream: typeof streamSimple,
  typebox: import.meta.resolve('typebox'),
};
try { await import('conductor-missing-dependency'); }
catch (error) { result.missing = error.message; }
`,
  );
  const script = `
import { registerCliPeerResolution } from ${JSON.stringify(join(packageRoot, "dist/bin/cli-peer-resolution.js"))};
registerCliPeerResolution();
const { result } = await import(${JSON.stringify(probe)});
console.log(JSON.stringify(result));
`;
  const result = invoke(["--eval", script], { PI_PACKAGE_DIR: piRoot }, "--input-type=module");
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(output).toMatchObject({
    valid: true,
    stream: "function",
    typebox: pathToFileURL(createRequire(join(piRoot, "package.json")).resolve("typebox")).href,
    missing: expect.stringContaining(probe),
  });
});

it("uses locally installed SDK peers without requiring Pi on PATH", () => {
  const scope = join(packageRoot, "node_modules/@earendil-works");
  mkdirSync(scope);
  const sdkLink = join(scope, "pi-coding-agent");
  symlinkSync(piRoot, sdkLink);
  try {
    const result = invoke([], { PATH: "" });
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 2,
      stderr: expect.stringContaining("Usage: conduct"),
    });
  } finally {
    rmSync(sdkLink);
  }
});
