import { Worker } from "node:worker_threads";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxFileTools } from "../../src/host/execution/sandbox/file-tools.js";
import { SandboxOperationGate } from "../../src/host/execution/sandbox/operation-gate.js";
import {
  cleanupSandboxProjectFixture,
  createSandboxProjectFixture,
  materializeFixture,
} from "./fixtures/sandbox-project-fixture.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const root of cleanups.splice(0)) await cleanupSandboxProjectFixture(root);
});

async function fixture(options?: {
  readonly selectedPaths?: readonly string[];
  readonly writablePaths?: readonly string[];
}) {
  const value = await createSandboxProjectFixture(options);
  cleanups.push(value.root);
  const project = await materializeFixture(value);
  const tools = createSandboxFileTools({
    gate: new SandboxOperationGate({ runId: "run-1", childId: "child-1" }),
    admission: value.admission,
    project,
    runStateDir: value.runStateDir,
  });
  return { tools, value, project };
}

async function call(
  tools: readonly ToolDefinition[],
  name: string,
  args: unknown,
): Promise<AgentToolResult<unknown>> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing ${name}`);
  return (
    tool.execute as (
      id: string,
      input: unknown,
      signal: AbortSignal,
    ) => Promise<AgentToolResult<unknown>>
  )("call", args, new AbortController().signal);
}
function output(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("sandbox descriptor-anchored file tools", () => {
  it("rejects malformed search worker transport input", async () => {
    const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const worker = new Worker(
      new URL(
        `../../src/host/execution/sandbox/project-file-search-worker${extension}`,
        import.meta.url,
      ),
      {
        workerData: { kind: "find", files: [], pattern: "*", limit: 1, extra: true },
        execArgv: [],
      },
    );
    const response = await new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    await worker.terminate();
    expect(response).toEqual({ error: "sandbox search worker received an invalid request" });
  });

  it("serves the normal read/write/edit/ls/find/grep protocol in one virtual workspace", async () => {
    const { tools } = await fixture();
    expect(output(await call(tools, "read", { path: "/workspace/src/a.ts" }))).toContain("a");
    await call(tools, "write", { path: "src/new.ts", content: "alpha\nTODO" });
    expect(
      output(
        await call(tools, "edit", {
          path: "src/new.ts",
          edits: [{ oldText: "alpha", newText: "beta" }],
        }),
      ),
    ).toContain("Edited");
    expect(output(await call(tools, "ls", { path: "src" }))).toContain("new.ts");
    expect(output(await call(tools, "find", { path: "src", pattern: "*.ts" }))).toContain(
      "src/new.ts",
    );
    expect(output(await call(tools, "grep", { path: "src", pattern: "T.+O" }))).toContain(
      "src/new.ts:2:TODO",
    );
  });

  it("denies read-only base files and retains writable-root authority", async () => {
    const { tools } = await fixture({ writablePaths: ["src"] });
    await expect(call(tools, "write", { path: "package.json", content: "no" })).rejects.toThrow(
      "read-only",
    );
  });

  it("matches ** globs against root and nested files without letting * cross directories", async () => {
    const { tools } = await fixture();
    await call(tools, "write", { path: "src/nested/deep.ts", content: "nested" });
    expect(output(await call(tools, "find", { pattern: "**/*.ts" })).split("\n")).toEqual([
      "src/a.ts",
      "src/nested/deep.ts",
    ]);
    expect(output(await call(tools, "find", { pattern: "*.ts" }))).toBe(
      "No files found matching pattern",
    );
  });

  it("returns bounded grep context with an explicit output truncation notice", async () => {
    const { tools } = await fixture();
    const rows = Array.from({ length: 4_000 }, (_, index) =>
      index % 2 === 0 ? `match-${index}-${"x".repeat(40)}` : `context-${index}-${"y".repeat(40)}`,
    );
    await call(tools, "write", { path: "src/huge.ts", content: rows.join("\n") });
    const result = output(
      await call(tools, "grep", { pattern: "match", glob: "**/*.ts", context: 1 }),
    );
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(64 * 1024);
    expect(result).toContain("src/huge.ts:2-context-");
    expect(result).toContain("[output truncated at 65536 bytes]");
  });

  it("caps read previews while supporting line offsets and large authorized edits", async () => {
    const { tools } = await fixture();
    const content = `${Array.from({ length: 2_100 }, (_, index) => `line-${index}`).join("\n")}\n${"z".repeat(2 * 1024 * 1024)}`;
    await call(tools, "write", { path: "src/large.txt", content });
    const preview = output(await call(tools, "read", { path: "src/large.txt" }));
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(64 * 1024);
    expect(preview).toContain("[preview truncated");
    expect(
      output(await call(tools, "read", { path: "src/large.txt", offset: 2101, limit: 1 })),
    ).toContain("zzz");
    await expect(
      call(tools, "edit", {
        path: "src/large.txt",
        edits: [{ oldText: "line-0", newText: "changed" }],
      }),
    ).resolves.toBeDefined();
  });

  it("uses the verified descriptor snapshot captured by the factory", async () => {
    const value = await createSandboxProjectFixture();
    cleanups.push(value.root);
    const project = await materializeFixture(value);
    const mutable = structuredClone(project);
    const tools = createSandboxFileTools({
      gate: new SandboxOperationGate({ runId: "run-1", childId: "child-1" }),
      admission: value.admission,
      project: mutable,
      runStateDir: value.runStateDir,
    });
    (mutable as { basePath: string }).basePath = "/etc";
    expect(output(await call(tools, "read", { path: "package.json" }))).toContain("{}");
  });

  it("rejects an invalid descriptor before attempting its outside paths", async () => {
    const value = await createSandboxProjectFixture();
    cleanups.push(value.root);
    const project = await materializeFixture(value);
    const tools = createSandboxFileTools({
      gate: new SandboxOperationGate({ runId: "run-1", childId: "child-1" }),
      admission: value.admission,
      project: { ...project, basePath: "/outside-must-not-be-opened" },
      runStateDir: value.runStateDir,
    });
    await expect(call(tools, "read", { path: "package.json" })).rejects.toThrow(
      "descriptor authority is inconsistent",
    );
  });

  it("rejects grep context above its fixed bound", async () => {
    const { tools } = await fixture();
    await expect(call(tools, "grep", { pattern: "a", context: 101 })).rejects.toThrow(
      "0 through 100",
    );
  });

  it("times out pathological regex evaluation without blocking the host", async () => {
    const { tools } = await fixture();
    await call(tools, "write", { path: "src/redos.txt", content: `${"a".repeat(200_000)}!` });
    const started = Date.now();
    await expect(call(tools, "grep", { pattern: "^(a+)+$" })).rejects.toThrow(
      "search exceeded 500ms",
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports malformed regex as a repairable tool error", async () => {
    const { tools } = await fixture();
    await expect(call(tools, "grep", { pattern: "[" })).rejects.toThrow(
      "Invalid regular expression",
    );
    await expect(call(tools, "read", { path: "package.json" })).resolves.toBeDefined();
  });

  it("holds a queued gate operation until an aborted search worker terminates", async () => {
    const { tools } = await fixture();
    await call(tools, "write", { path: "src/redos.txt", content: `${"a".repeat(200_000)}!` });
    const grep = tools.find((candidate) => candidate.name === "grep");
    if (grep === undefined) throw new Error("missing grep");
    const controller = new AbortController();
    const order: string[] = [];
    const active = (
      grep.execute as (
        id: string,
        input: unknown,
        signal: AbortSignal,
      ) => Promise<AgentToolResult<unknown>>
    )("call", { pattern: "^(a+)+$" }, controller.signal).finally(() => order.push("search"));
    const queued = call(tools, "read", { path: "package.json" }).finally(() => order.push("read"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    await expect(active).rejects.toThrow("aborted");
    await expect(queued).resolves.toBeDefined();
    expect(order).toEqual(["search", "read"]);
  });
});
