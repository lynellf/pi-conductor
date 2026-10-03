import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  createPackedBashFixture,
  disposePackedBashFixture,
} from "./packed-bash-supervision-fixture.js";

it("loads the packed real extension and runs stock tools, handoffs and an end guard natively", () => {
  const fixture = createPackedBashFixture();
  try {
    const sdkRequire = createRequire(join(fixture.piRoot, "package.json"));
    const scope = join(fixture.packageRoot, "node_modules/@earendil-works");
    mkdirSync(scope, { recursive: true });
    symlinkSync(fixture.piRoot, join(scope, "pi-coding-agent"));
    for (const name of ["@earendil-works/pi-ai", "typebox"]) {
      const root = sdkRequire.resolve
        .paths(name)
        ?.map((path) => join(path, name))
        .find((path) => existsSync(join(path, "package.json")));
      if (root === undefined) throw new Error(`installed peer missing: ${name}`);
      symlinkSync(root, join(fixture.packageRoot, "node_modules", name));
    }
    const project = join(fixture.sandbox, "project");
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(
      join(project, ".pi/conductor.yaml"),
      `version: 1\nend_guard: {command: '${process.execPath} -e "process.exit(0)"', timeout_seconds: 5}\nroles:\n  - name: orchestrator\n    is_orchestrator: true\n    models: [stub:stub-model]\n    tools: [handoff, end]\n  - name: worker\n    max_visits: 1\n    models: [stub:stub-model]\n    tools: [write, edit, read, bash, handoff]\n`,
    );
    const script = join(fixture.sandbox, "extension-probe.mjs");
    writeFileSync(
      script,
      `
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, DefaultResourceLoader } from ${JSON.stringify(pathToFileURL(join(fixture.piRoot, "dist/index.js")).href)};
import { makeStubModel, makeStubStreamFunction } from ${JSON.stringify(pathToFileURL(join(fixture.packageRoot, "dist/host/stub-provider.js")).href)};
const project = ${JSON.stringify(project)};
const model = makeStubModel();
const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
registry.registerProvider("stub", { api: model.api, baseUrl: model.baseUrl, apiKey: "unused", models: [{ ...model, input: [...model.input] }], streamSimple: makeStubStreamFunction({ steps: [
{kind:"emit_handoff",target_role:"worker"},
{kind:"emit_tool_calls",calls:[{name:"write",arguments:{path:"result.txt",content:"before"}}]},
{kind:"emit_tool_calls",calls:[{name:"edit",arguments:{path:"result.txt",edits:[{oldText:"before",newText:"after"}]}}]},
{kind:"emit_tool_calls",calls:[{name:"read",arguments:{path:"result.txt"}}]},
{kind:"emit_tool_calls",calls:[{name:"bash",arguments:{command:"printf packed-native"}}]},
{kind:"emit_handoff",target_role:"orchestrator"}, {kind:"emit_end",reason:"verified"}
]}) });
const resourceLoader = new DefaultResourceLoader({ cwd: project, agentDir: process.env.PI_CODING_AGENT_DIR, additionalExtensionPaths: [${JSON.stringify(join(fixture.packageRoot, "extensions/conduct.ts"))}], noSkills: true, noPromptTemplates: true, noThemes: true });
await resourceLoader.reload();
const loaded = resourceLoader.getExtensions();
assert.deepEqual(loaded.errors, []);
loaded.runtime.sendMessage = () => {};
const command = loaded.extensions.flatMap(ext => [...ext.commands]).find(([name]) => name === "conduct")?.[1];
assert.ok(command);
const notices = [];
await command.handler("packed native portability", { cwd: project, hasUI: false, modelRegistry: registry, isIdle: () => true, waitForIdle: async () => {}, sessionManager: {getSessionId: () => "probe", getSessionFile: () => "probe.jsonl"}, ui: {notify: (message, level) => notices.push({message,level}),setStatus: () => {},onTerminalInput: () => () => {}} });
assert.equal(readFileSync(join(project,"result.txt"),"utf8"), "after");
function records(directory) { return readdirSync(directory,{withFileTypes:true}).flatMap(entry => entry.isDirectory() ? records(join(directory,entry.name)) : entry.name.endsWith(".jsonl") ? readFileSync(join(directory,entry.name),"utf8").trim().split("\\n").map(line=>JSON.parse(line)) : []); }
const all = records(join(project,".pi-conductor/runs"));
const selection = all.find(record=>record.type === "execution_capabilities");
assert.ok(selection);
const guard = all.find(record=>record.type === "end_guard_finished");
assert.equal(guard?.outcome,"passed");
if(selection.execution_tier === "baseline") {
assert.equal(all.filter(record=>record.type === "baseline_execution_finished").length,4);
assert.equal(guard.cleanup,"not-guaranteed");
assert.equal(all.some(record=>record.type === "tool_execution_started"),false);
} else assert.equal(guard.cleanup,"confirmed");
assert.ok(notices.some(notice=>notice.message.includes("done")),JSON.stringify(notices));
console.log(JSON.stringify({packed:true,extension:true,tier:selection.execution_tier,tools:4,handoffs:2,guard:guard.outcome}));
`,
    );
    const stdout = execFileSync(process.execPath, [script], {
      cwd: project,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(fixture.sandbox, "agent") },
    });
    expect(stdout).toContain('"packed":true');
    expect(stdout).toContain('"guard":"passed"');
    if (process.platform !== "linux") expect(stdout).toContain('"tier":"baseline"');
  } finally {
    disposePackedBashFixture(fixture);
  }
}, 180_000);
