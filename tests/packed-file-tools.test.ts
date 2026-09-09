import { execFileSync } from "node:child_process";
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
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

/**
 * Packed npm layout regression for issue #99. This deliberately exercises the
 * extension loader and the public tool boundary in a process whose cwd is
 * outside the checkout.
 */
it("loads packed child file tools from a Pi-owned SDK and keeps all six tools confined", () => {
  const checkout = fileURLToPath(new URL("../", import.meta.url));
  const sandbox = mkdtempSync(join("/tmp", "pi-conductor-packed-tools-"));
  const packageRoot = join(sandbox, "pi-user", "node_modules", "pi-conductor");
  const packageNodeModules = join(packageRoot, "node_modules");
  const worktree = join(sandbox, "worktree");
  const probe = join(sandbox, "probe.mjs");
  mkdirSync(packageNodeModules, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "readme.txt"), "needle from packed package\n");

  try {
    execFileSync("pnpm", ["pack", "--pack-destination", sandbox], {
      cwd: checkout,
      stdio: "pipe",
      timeout: 120_000,
    });
    const archive = readdirSync(sandbox).find((entry) => entry.endsWith(".tgz"));
    if (archive === undefined) throw new Error("pnpm pack did not produce an archive");
    mkdirSync(packageRoot, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      join(sandbox, archive),
      "--strip-components=1",
      "-C",
      packageRoot,
    ]);
    const archiveListing = execFileSync("tar", ["-tzf", join(sandbox, archive)], {
      encoding: "utf8",
    });
    expect(archiveListing).not.toContain("@earendil-works/pi-coding-agent/");
    // The package tarball must not carry a private copy of Pi. Runtime deps are
    // represented exactly as they are in a normal npm package installation.
    for (const dependency of ["diff", "yaml"]) {
      symlinkSync(
        resolve(checkout, "node_modules", dependency),
        join(packageNodeModules, dependency),
      );
    }
    const piRoot = process.env.CONDUCTOR_SMOKE_PI_ROOT ?? packageDirFromImport();

    writeFileSync(
      probe,
      `import { buildChildTools } from ${JSON.stringify(join(packageRoot, "src/host/delegation/run-tool.ts"))};
import { ToolExecutionController } from ${JSON.stringify(join(packageRoot, "src/host/execution/tool-execution-controller.ts"))};
import { DEFAULT_TOOL_EXECUTION_POLICY } from ${JSON.stringify(join(packageRoot, "src/manifest/execution-policy.ts"))};
const root = process.env.CONDUCTOR_SMOKE_WORKTREE;
const records = [];
const controller = new ToolExecutionController({ runId: "packed", logicalSessionId: "packed:child", roleSessionId: "child", policy: DEFAULT_TOOL_EXECUTION_POLICY, persist: record => records.push(record) });
const tools = buildChildTools({ worktreePath: root, getController: () => controller, getPolicy: () => DEFAULT_TOOL_EXECUTION_POLICY });
export default function probe(pi) { for (const tool of tools) pi.registerTool(tool); }
export { records };`,
    );

    const loader = pathToFileURL(join(piRoot, "dist/core/extensions/loader.js"));
    const conductorExtension = join(packageRoot, "extensions/conduct.ts");
    const script = `
const { loadExtensions } = await import(${JSON.stringify(loader.href)});
const result = await loadExtensions([${JSON.stringify(conductorExtension)}, ${JSON.stringify(probe)}], ${JSON.stringify(sandbox)});
if (result.errors.length) throw new Error(JSON.stringify(result.errors));
const { findPackageJSON } = await import('node:module');
let packageSdk;
try { packageSdk = findPackageJSON('@earendil-works/pi-coding-agent', ${JSON.stringify(pathToFileURL(join(packageRoot, "src/host/execution/file-tool-worker.ts")).href)}); } catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
if (packageSdk !== undefined) throw new Error('packed package unexpectedly contains a local Pi SDK');
const extension = result.extensions[1];
const invoke = async (name, params) => {
  const tool = extension.tools.get(name)?.definition;
  if (!tool) throw new Error('missing tool ' + name);
  const value = await tool.execute('packed-' + name, params, undefined, undefined, { model: undefined });
  return value.content.map(part => part.type === 'text' ? part.text : '').join('');
};
const out = {};
out.commands = [...result.extensions[0].commands.keys()];
out.names = [...extension.tools.keys()];
out.read = await invoke('read', { path: 'readme.txt' });
out.grep = await invoke('grep', { pattern: 'needle', path: '.' });
out.find = await invoke('find', { pattern: '*.txt', path: '.' });
out.ls = await invoke('ls', { path: '.' });
out.write = await invoke('write', { path: 'created.txt', content: 'created\\n' });
out.edit = await invoke('edit', { path: 'created.txt', edits: [{ oldText: 'created', newText: 'edited' }] });
out.traversal = await invoke('read', { path: '../outside.txt' });
console.log(JSON.stringify(out));
`;
    const smokeNode = process.env.CONDUCTOR_SMOKE_NODE ?? process.execPath;
    const output = execFileSync(smokeNode, ["--input-type=module", "-e", script], {
      cwd: sandbox,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: join(sandbox, "pi-user"),
        CONDUCTOR_SMOKE_WORKTREE: worktree,
      },
    });
    const result = JSON.parse(output.trim()) as Record<string, unknown>;
    expect(result.commands).toEqual(
      expect.arrayContaining(["conduct", "conduct:resume", "conduct:list", "conduct:abort"]),
    );
    expect(result.names).toEqual(["read", "write", "edit", "ls", "find", "grep"]);
    expect(result.read).toContain("needle from packed package");
    expect(result.grep).toContain("needle");
    expect(result.find).toContain("readme.txt");
    expect(result.ls).toContain("readme.txt");
    expect(result.write).toContain("created.txt");
    expect(result.edit).toContain("Successfully replaced");
    expect(result.traversal).toContain("path must be relative");
    expect(readFileSync(join(worktree, "created.txt"), "utf8")).toBe("edited\n");
    expect(result.names).not.toContain("bash");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}, 180_000);

function packageDirFromImport(): string {
  return realpathSync(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent"));
}
