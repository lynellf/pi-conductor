import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Manifest with three isolated roles for pinning and resume scenarios. */
export function isolatedRolesManifest(source: "snapshot" | `ref:${string}`): string {
  return `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: implementer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
    workspace: { backend: worktree, source: ${source} }
  - name: reviewer
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
    workspace: { backend: worktree, source: ${source} }
  - name: auditor
    max_visits: 3
    models: [{ model: stub:stub-model, effort: medium }]
    tools: [read, handoff, end]
    workspace: { backend: worktree, source: ${source} }
`;
}

/** Commit one fixture file into a Git integration checkout. */
export async function commitFile(dir: string, filename: string, content: string): Promise<void> {
  await writeFile(join(dir, filename), content, "utf8");
  await execFileAsync("git", ["add", filename], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", `add ${filename}`], { cwd: dir });
}

/** Resolve one Git revision in a fixture checkout. */
export async function gitRevision(dir: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", ref], { cwd: dir });
  return stdout.trim();
}

/** Initialize the Git fixture used by snapshot tests. */
export async function initializeGitFixture(dir: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "# immutable pin fixture\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: dir });
}
