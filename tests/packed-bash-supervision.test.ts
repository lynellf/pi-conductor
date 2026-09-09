import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import {
  createPackedBashFixture,
  disposePackedBashFixture,
  killOwnedProcesses,
  loaderUrl,
  ownedProcesses,
  writePackedBashProbe,
} from "./packed-bash-supervision-fixture.js";

interface ToolError {
  readonly message?: string;
  readonly code?: string;
  readonly cleanup?: string;
}
interface Invocation {
  readonly error?: ToolError;
  readonly result?: string;
}
interface SmokeOutput {
  readonly foreground: Invocation;
  readonly background: Invocation;
  readonly foregroundOwned: number;
  readonly backgroundOwned: readonly Record<string, unknown>[];
}
interface RecordEntry {
  readonly type?: string;
  readonly supervision_id?: string;
  readonly diagnostic?: unknown;
}

function diagnostic(error: ToolError | undefined): Record<string, unknown> {
  if (error?.message === undefined) throw new Error("tool error omitted model diagnostic");
  const envelope = JSON.parse(error.message) as { diagnostic?: Record<string, unknown> };
  if (envelope.diagnostic === undefined)
    throw new Error("tool error omitted structured diagnostic");
  return envelope.diagnostic;
}

function runSmoke(
  fixture: ReturnType<typeof createPackedBashFixture>,
  launcher: "fast" | "delayed",
): SmokeOutput {
  const script = `
const { findPackageJSON } = await import("node:module");
let packageSdk;
try { packageSdk = findPackageJSON("@earendil-works/pi-coding-agent", ${JSON.stringify(`${fixture.packageRoot}/src/host/execution/supervised-tools.ts`)}); } catch (error) { if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error; }
if (packageSdk !== undefined) throw new Error("packed package unexpectedly contains a local Pi SDK");
const { loadExtensions } = await import(${JSON.stringify(loaderUrl(fixture))});
const result = await loadExtensions([${JSON.stringify(`${fixture.packageRoot}/extensions/conduct.ts`)}, ${JSON.stringify(fixture.probe)}], ${JSON.stringify(fixture.sandbox)});
if (result.errors.length) throw new Error(JSON.stringify(result.errors));
const tool = result.extensions[1].tools.get("bash")?.definition;
if (!tool) throw new Error("missing packaged bash tool");
const toolContext = { model: undefined, sessionManager: { getSessionId: () => "packed-bash-session", getSessionFile: () => undefined } };
const invoke = async command => { try { const value = await tool.execute("packed-bash", { command, timeout: 1 }, undefined, undefined, toolContext); return { result: value.content.map(part => part.type === "text" ? part.text : "").join("") }; } catch (error) { return { error: { message: error?.message, code: error?.code, cleanup: error?.cleanup } }; } };
const node = JSON.stringify(process.execPath);
const { readProcessIdentity, findProcessesByOwnerToken } = await import(${JSON.stringify(`${fixture.packageRoot}/dist/host/execution/supervised-process-identity.js`)});
const runnerIdentity = await readProcessIdentity(process.pid);
if (runnerIdentity === null) throw new Error("could not identify smoke runner");
const foreground = await invoke(node + ' -e "setTimeout(() => {}, 3000)"');
const records = JSON.parse((await import("node:fs")).readFileSync(${JSON.stringify(fixture.state)}, "utf8"));
const supervision = records.find(record => record.type === "tool_execution_started")?.supervision_id;
if (supervision === undefined) throw new Error("foreground start record omitted supervision ID");
const foregroundOwned = (await findProcessesByOwnerToken(supervision, runnerIdentity.startTime)).length;
const background = await invoke(${launcher === "delayed" ? `'nohup ' + node + ' -e "setTimeout(() => {}, 10000)" >/dev/null 2>&1 & sleep .2; echo done'` : `'nohup ' + node + ' -e "setTimeout(() => {}, 10000)" >/dev/null 2>&1 & echo $!'`});
const afterBackground = JSON.parse((await import("node:fs")).readFileSync(${JSON.stringify(fixture.state)}, "utf8"));
const backgroundStart = afterBackground.filter(record => record.type === "tool_execution_started").at(-1)?.supervision_id;
if (backgroundStart === undefined) throw new Error("background start record omitted supervision ID");
const backgroundOwned = await findProcessesByOwnerToken(backgroundStart, runnerIdentity.startTime);
console.log(JSON.stringify({ foreground, background, foregroundOwned, backgroundOwned }));
`;
  const output = execFileSync(
    process.env.CONDUCTOR_SMOKE_NODE ?? process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: fixture.sandbox,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: `${fixture.sandbox}/pi-user`,
        CONDUCTOR_SMOKE_RECORDS: fixture.state,
      },
    },
  );
  const line = output.trim().split("\n").at(-1);
  if (line === undefined) throw new Error("packed smoke produced no JSON output");
  return JSON.parse(line) as SmokeOutput;
}

it("supervises packed bash foreground and background process boundaries", async () => {
  const fixture = createPackedBashFixture();
  const supervisionIds: string[] = [];
  try {
    writePackedBashProbe(fixture);
    for (const launcher of ["fast", "delayed"] as const) {
      const smoke = runSmoke(fixture, launcher);
      const records = JSON.parse(readFileSync(fixture.state, "utf8")) as RecordEntry[];
      supervisionIds.push(
        ...records
          .filter((record) => record.type === "tool_execution_started")
          .map((record) => record.supervision_id)
          .filter((id): id is string => id !== undefined),
      );
      expect(smoke.foreground.error?.code, smoke.foreground.error?.message).toBe("tool_timeout");
      expect(smoke.foreground.error?.cleanup).toBe("confirmed");
      expect(smoke.foregroundOwned).toBe(0);
      const background = diagnostic(smoke.background.error);
      const durableBackground = records
        .filter((record) => record.type === "tool_execution_finished")
        .at(-1);
      expect(durableBackground?.diagnostic).toEqual(background);
      expect(smoke.background.error?.code).toBe("tool_cleanup_unconfirmed");
      expect(smoke.background.error?.cleanup).toBe("unconfirmed");
      expect(typeof background.cleanup_cause).toBe("string");
      expect(typeof background.leader_observed).toBe("boolean");
      expect(Array.isArray(background.observed_members)).toBe(true);
      const observedMembers = background.observed_members as Array<Record<string, unknown>>;
      expect(observedMembers.length).toBeGreaterThan(0);
      expect(smoke.backgroundOwned.length).toBeGreaterThan(0);
      for (const member of observedMembers) {
        expect(
          smoke.backgroundOwned.some(
            (actual) =>
              actual.pid === member.pid &&
              actual.startTime === member.start_time &&
              actual.processGroupId === member.process_group_id,
          ),
        ).toBe(true);
      }
      expect(
        observedMembers.every(
          (member) =>
            typeof member.pid === "number" &&
            typeof member.start_time === "string" &&
            typeof member.process_group_id === "number",
        ),
      ).toBe(true);
      if (launcher === "delayed") expect(background.leader_observed).toBe(true);
      for (const supervisionId of new Set(supervisionIds)) {
        await killOwnedProcesses(supervisionId);
        expect(await ownedProcesses(supervisionId)).toHaveLength(0);
      }
    }
  } finally {
    try {
      try {
        const records = JSON.parse(readFileSync(fixture.state, "utf8")) as RecordEntry[];
        supervisionIds.push(
          ...records
            .filter((record) => record.type === "tool_execution_started")
            .map((record) => record.supervision_id)
            .filter((id): id is string => id !== undefined),
        );
      } catch {}
      const uniqueSupervisionIds = [...new Set(supervisionIds)];
      for (const supervisionId of uniqueSupervisionIds) {
        await killOwnedProcesses(supervisionId);
        expect(await ownedProcesses(supervisionId)).toHaveLength(0);
      }
    } finally {
      disposePackedBashFixture(fixture);
    }
  }
}, 180_000);
