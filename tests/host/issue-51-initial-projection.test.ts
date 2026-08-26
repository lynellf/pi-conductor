import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Role } from "../../src/core/types.js";
import { FileRecordLog } from "../../src/host/log-file.js";
import { MACHINE_TOOLS_CONFIG_ENV } from "../../src/host/rpc/machine-tools-config.js";
import { InMemoryRecordLog, loadManifestFromString } from "../../src/index.js";
import type { PersistedRecord } from "../../src/persistence/log.js";
import { makeModelRegistryWithStub } from "./production-host-fixture.js";
import { HostFakeRpcChild } from "./rpc/host-rpc-fixture.js";

const execFileAsync = promisify(execFile);
const forcedFilesystemFailure = vi.hoisted(() => ({
  releaseBlockedChmod: undefined as (() => void) | undefined,
  onChmod: undefined as ((path: string) => Promise<void>) | undefined,
  onRename: undefined as
    | ((
        sourcePath: string,
        destinationPath: string,
        renameFile: () => Promise<void>,
      ) => Promise<void>)
    | undefined,
  onLink: undefined as ((sourcePath: string, destinationPath: string) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    chmod: async (path: string | Buffer | URL, mode: number) => {
      await forcedFilesystemFailure.onChmod?.(path.toString());
      return original.chmod(path, mode);
    },
    rename: async (sourcePath: string | Buffer | URL, destinationPath: string | Buffer | URL) => {
      const renameFile = () => original.rename(sourcePath, destinationPath);
      await forcedFilesystemFailure.onRename?.(
        sourcePath.toString(),
        destinationPath.toString(),
        renameFile,
      );
      if (forcedFilesystemFailure.onRename === undefined) await renameFile();
    },
    link: async (sourcePath: string | Buffer | URL, destinationPath: string | Buffer | URL) => {
      forcedFilesystemFailure.onLink?.(sourcePath.toString(), destinationPath.toString());
      return original.link(sourcePath, destinationPath);
    },
  };
});

const READER = "reader" as Role;
const SELECTED_CANARY = "selected-canary";
const REVEALED_CANARY = "newly-disclosed-canary";
const REQUESTED_SIBLING_CANARY = "policy-allowed-sibling-canary";
const FIRST_BATCH_CANARY = "first-batch-canary";
const BLOCKED_BATCH_CANARY = "blocked-batch-canary";
const SIBLING_CANARY = "policy-denied-sibling-canary";

interface ToolExecutionResult {
  readonly content: readonly unknown[];
  readonly details: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly terminate?: boolean;
}

interface RegisteredTool {
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: unknown,
  ): Promise<ToolExecutionResult>;
}

interface IsolatedReader {
  readonly workspacePath: string;
  readonly machineToolsConfigPath: string;
  readonly requestFilesBridgeProvisioned: boolean;
  readonly dispose: () => Promise<void>;
}

interface PoisonedGitPointer {
  readonly restore: () => Promise<void>;
  readonly expectUntouched: () => Promise<void>;
}

// This suite replaces a process-wide Node built-in; run its injected filesystem failures serially.
describe.sequential("Issue #51 initial progressive projection", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    forcedFilesystemFailure.releaseBlockedChmod?.();
    forcedFilesystemFailure.releaseBlockedChmod = undefined;
    forcedFilesystemFailure.onChmod = undefined;
    forcedFilesystemFailure.onLink = undefined;
    forcedFilesystemFailure.onRename = undefined;
  });
  it("uses host-captured Git authority to disclose one approved file through the isolated RPC path", async () => {
    const repository = await createRepository();
    let reader: IsolatedReader | null = null;
    let poisonedGitPointer: PoisonedGitPointer | null = null;
    try {
      const logDir = join(repository, "record-log");
      const log = new FileRecordLog({ baseDir: logDir });
      reader = await spawnIsolatedReader({ repository, progressiveDisclosure: true, log });
      const tools = await registerMachineTools(reader.machineToolsConfigPath);
      const configuredToolNames = [...tools.keys()].sort();
      const configBeforeDeniedRequest = await readFile(reader.machineToolsConfigPath, "utf8");

      expect(configuredToolNames).toEqual(["end", "handoff", "read", "request_files", "write"]);
      expect(await readThroughTool(tools, "selected/visible.txt")).toContain(SELECTED_CANARY);

      poisonedGitPointer = await poisonWorkspaceGitPointer({ repository, reader });
      const requestFiles = requiredTool(tools, "request_files");
      const directoryDenied = await requestFiles.execute(
        "issue-51-directory-request",
        {
          paths: ["requested"],
          reason: "A policy prefix is not an exact file disclosure request.",
        },
        undefined,
        undefined,
        {},
      );

      expect(directoryDenied).toMatchObject({
        details: {
          outcome: "denied",
          code: "not-regular-file",
          path: "requested",
        },
        isError: true,
        terminate: false,
      });
      await expect(
        readFile(join(reader.workspacePath, "requested", "revealed.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const approved = await requestFiles.execute(
        "issue-51-approved-request",
        {
          paths: ["requested/revealed.txt"],
          reason: "The visible task input requires this declared dependency.",
        },
        undefined,
        undefined,
        {},
      );

      expect(approved).toMatchObject({
        details: {
          outcome: "approved",
          disclosed_paths: ["requested/revealed.txt"],
        },
        isError: false,
        terminate: false,
      });
      expect(await readThroughTool(tools, "requested/revealed.txt")).toContain(REVEALED_CANARY);
      await expect(
        readFile(join(reader.workspacePath, "requested", "hidden-sibling.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await rejectedReadMessage(tools, "requested/hidden-sibling.txt")).not.toContain(
        REQUESTED_SIBLING_CANARY,
      );
      await poisonedGitPointer.expectUntouched();

      const write = requiredTool(tools, "write");
      await write.execute(
        "issue-51-existing-write",
        { path: "selected/visible.txt", content: `${SELECTED_CANARY}-updated` },
        undefined,
        undefined,
        {},
      );
      expect(await readThroughTool(tools, "selected/visible.txt")).toContain(
        `${SELECTED_CANARY}-updated`,
      );
      const [selectedMetadata, disclosedMetadata] = await Promise.all([
        lstat(join(reader.workspacePath, "selected", "visible.txt")),
        lstat(join(reader.workspacePath, "requested", "revealed.txt")),
      ]);
      expect(disclosedMetadata.mode & 0o777).toBe(selectedMetadata.mode & 0o777);
      await write.execute(
        "issue-51-disclosed-write",
        { path: "requested/revealed.txt", content: `${REVEALED_CANARY}-updated` },
        undefined,
        undefined,
        {},
      );
      expect(await readThroughTool(tools, "requested/revealed.txt")).toContain(
        `${REVEALED_CANARY}-updated`,
      );

      await expect(
        readFile(join(reader.workspacePath, "sibling", "secret.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const requestSiblingError = await rejectedReadMessage(tools, "sibling/secret.txt");
      expect(requestSiblingError).not.toContain(SIBLING_CANARY);

      const denied = await requestFiles.execute(
        "issue-51-denied-request",
        {
          paths: ["sibling/secret.txt"],
          reason: "This path is outside the role's configured disclosure policy.",
        },
        undefined,
        undefined,
        {},
      );

      expect(denied).toMatchObject({
        details: {
          outcome: "denied",
          code: "not-allowed",
          path: "sibling/secret.txt",
        },
        isError: true,
        terminate: false,
      });
      await expect(
        readFile(join(reader.workspacePath, "sibling", "secret.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await rejectedReadMessage(tools, "sibling/secret.txt")).not.toContain(SIBLING_CANARY);

      const traversalDenied = await requestFiles.execute(
        "issue-51-traversal-denied-request",
        {
          paths: ["../sibling/secret.txt"],
          reason: "The path is deliberately invalid to verify the isolated boundary.",
        },
        undefined,
        undefined,
        {},
      );

      expect(traversalDenied).toMatchObject({
        details: {
          outcome: "denied",
          code: "unsafe-path",
          path: "../sibling/secret.txt",
        },
        isError: true,
        terminate: false,
      });
      expect(await readFile(reader.machineToolsConfigPath, "utf8")).toBe(configBeforeDeniedRequest);
      expect([...tools.keys()].sort()).toEqual(configuredToolNames);

      expect(
        log
          .records("issue-51-test-run")
          .filter((record) => record.type === "progressive_disclosure"),
      ).toHaveLength(4);
      const records = await readRawRecords(join(logDir, "issue-51-test-run.jsonl"));
      const disclosureRecords = records.filter(
        (record) => record.type === "progressive_disclosure",
      );
      expect(disclosureRecords).toEqual([
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["requested"],
          reason: "A policy prefix is not an exact file disclosure request.",
          outcome: "denied",
          disclosed_paths: [],
        }),
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["requested/revealed.txt"],
          reason: "The visible task input requires this declared dependency.",
          outcome: "approved",
          disclosed_paths: ["requested/revealed.txt"],
        }),
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["sibling/secret.txt"],
          reason: "This path is outside the role's configured disclosure policy.",
          outcome: "denied",
          disclosed_paths: [],
        }),
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["../sibling/secret.txt"],
          reason: "The path is deliberately invalid to verify the isolated boundary.",
          outcome: "denied",
          disclosed_paths: [],
        }),
      ]);
    } finally {
      await poisonedGitPointer?.restore();
      await reader?.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("rejects a whitespace-only reason before bridge framing, disclosure, or audit", async () => {
    const repository = await createRepository();
    let reader: IsolatedReader | null = null;
    const bridgeRequestFrames: string[] = [];
    try {
      const log = new FileRecordLog({ baseDir: join(repository, "record-log") });
      reader = await spawnIsolatedReader({ repository, progressiveDisclosure: true, log });
      const tools = await registerMachineTools(reader.machineToolsConfigPath);
      forcedFilesystemFailure.onLink = (_sourcePath, destinationPath) => {
        if (destinationPath.endsWith(".request.json")) bridgeRequestFrames.push(destinationPath);
      };

      let requestError: unknown;
      let requestResult: ToolExecutionResult | undefined;
      try {
        requestResult = await requiredTool(tools, "request_files").execute(
          "issue-51-whitespace-reason",
          { paths: ["requested/revealed.txt"], reason: "   " },
          undefined,
          undefined,
          {},
        );
      } catch (error) {
        requestError = error;
      }

      expect(requestError).toBeUndefined();
      expect(requestResult).toMatchObject({
        content: [
          {
            type: "text",
            text: "request_files unavailable: request_files bridge request arguments are invalid",
          },
        ],
        details: { outcome: "unavailable", code: "bridge-unavailable" },
        isError: true,
        terminate: false,
      });
      expect(bridgeRequestFrames).toEqual([]);
      await expect(
        readFile(join(reader.workspacePath, "requested", "revealed.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        log
          .records("issue-51-test-run")
          .filter((record) => record.type === "progressive_disclosure"),
      ).toHaveLength(0);
    } finally {
      forcedFilesystemFailure.onLink = undefined;
      await reader?.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("keeps a read-only role's disclosed regular file non-writable through the isolated RPC path", async () => {
    const repository = await createRepository();
    let reader: IsolatedReader | null = null;
    try {
      reader = await spawnIsolatedReader({
        repository,
        progressiveDisclosure: true,
        writable: false,
      });
      const tools = await registerMachineTools(reader.machineToolsConfigPath);

      const approved = await requiredTool(tools, "request_files").execute(
        "issue-51-read-only-disclosure",
        {
          paths: ["requested/revealed.txt"],
          reason: "The declared dependency must preserve the role's read-only policy.",
        },
        undefined,
        undefined,
        {},
      );

      expect(approved).toMatchObject({
        details: {
          outcome: "approved",
          disclosed_paths: ["requested/revealed.txt"],
        },
        isError: false,
        terminate: false,
      });
      expect(
        (await lstat(join(reader.workspacePath, "requested", "revealed.txt"))).mode & 0o222,
      ).toBe(0);
      expect(tools.has("write")).toBe(false);
    } finally {
      await reader?.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("poisons this visit after approved disclosure audit persistence fails without widening its projection", async () => {
    const repository = await createRepository();
    let reader: IsolatedReader | null = null;
    try {
      const logDir = join(repository, "record-log");
      const log = new FileRecordLog({ baseDir: logDir });
      const appendRecord = log.append.bind(log);
      let rejectApprovedAudit = true;
      vi.spyOn(log, "append").mockImplementation((record: PersistedRecord) => {
        if (
          rejectApprovedAudit &&
          record.type === "progressive_disclosure" &&
          record.outcome === "approved"
        ) {
          rejectApprovedAudit = false;
          throw new Error("forced approved disclosure audit persistence failure");
        }
        appendRecord(record);
      });
      reader = await spawnIsolatedReader({
        repository,
        progressiveDisclosure: true,
        writable: false,
        log,
      });
      const tools = await registerMachineTools(reader.machineToolsConfigPath);
      const requestFiles = requiredTool(tools, "request_files");
      const shutdown = vi.fn();

      const unavailable = await requestFiles.execute(
        "issue-51-approved-audit-persistence-failure",
        {
          paths: ["requested/revealed.txt"],
          reason: "The declared dependency must remain observable when its audit append fails.",
        },
        undefined,
        undefined,
        { shutdown },
      );

      expect(unavailable).toMatchObject({
        details: { outcome: "unavailable", code: "projection-compromised" },
        isError: true,
        terminate: true,
      });
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(await readThroughTool(tools, "requested/revealed.txt")).toContain(REVEALED_CANARY);
      await expect(
        readFile(join(reader.workspacePath, "requested", "hidden-sibling.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await rejectedWriteMessage(tools, "requested/revealed.txt", `${REVEALED_CANARY}-updated`),
      ).not.toContain(`${REVEALED_CANARY}-updated`);

      const poisoned = await requestFiles.execute(
        "issue-51-poisoned-follow-up",
        {
          paths: ["first/revealed.txt"],
          reason: "This otherwise-approved request must not expand a compromised projection.",
        },
        undefined,
        undefined,
        { shutdown: vi.fn() },
      );

      expect(poisoned).toMatchObject({
        details: { outcome: "unavailable", code: "projection-compromised" },
        isError: true,
        terminate: true,
      });
      await expect(
        readFile(join(reader.workspacePath, "first", "revealed.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      const records = await readRawRecords(join(logDir, "issue-51-test-run.jsonl"));
      expect(records.filter((record) => record.type === "progressive_disclosure")).toEqual([
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["requested/revealed.txt"],
          outcome: "unavailable",
          disclosed_paths: ["requested/revealed.txt"],
        }),
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["first/revealed.txt"],
          outcome: "unavailable",
          disclosed_paths: [],
        }),
      ]);
    } finally {
      await reader?.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("poisons this visit when an unrecoverable projection rollback follows publication", async () => {
    const repository = await createRepository();
    let reader: IsolatedReader | null = null;
    try {
      const logDir = join(repository, "record-log");
      const log = new FileRecordLog({ baseDir: logDir });
      reader = await spawnIsolatedReader({ repository, progressiveDisclosure: true, log });
      const tools = await registerMachineTools(reader.machineToolsConfigPath);
      const primaryIndexPath = await gitPath(reader.workspacePath, "index");
      const firstPublishedPath = join(reader.workspacePath, "requested", "revealed.txt");
      const failingPublishedPath = join(reader.workspacePath, "requested", "second-revealed.txt");
      let primaryIndexRenameCount = 0;
      forcedFilesystemFailure.onRename = async (_sourcePath, destinationPath, renameFile) => {
        if (destinationPath === firstPublishedPath) {
          await renameFile();
          return;
        }
        if (destinationPath === failingPublishedPath) {
          throw new Error("forced later final publication failure");
        }
        if (destinationPath === primaryIndexPath) {
          primaryIndexRenameCount += 1;
          if (primaryIndexRenameCount === 2) {
            throw new Error("forced rollback index restoration failure");
          }
        }
        await renameFile();
      };
      const shutdown = vi.fn();
      const requestFiles = requiredTool(tools, "request_files");

      const unavailable = await requestFiles.execute(
        "issue-51-unrecoverable-projection-rollback",
        {
          paths: ["requested/revealed.txt", "requested/second-revealed.txt"],
          reason: "The failed batch must expose its already-published paths in the fallback audit.",
        },
        undefined,
        undefined,
        { shutdown },
      );

      expect(unavailable).toMatchObject({
        details: { outcome: "unavailable", code: "projection-compromised" },
        isError: true,
        terminate: true,
      });
      expect(shutdown).toHaveBeenCalledTimes(1);

      const poisoned = await requestFiles.execute(
        "issue-51-unrecoverable-rollback-follow-up",
        {
          paths: ["first/revealed.txt"],
          reason: "A later allowed request must not expand an unrecoverable projection.",
        },
        undefined,
        undefined,
        { shutdown: vi.fn() },
      );

      expect(poisoned).toMatchObject({
        details: { outcome: "unavailable", code: "projection-compromised" },
        isError: true,
        terminate: true,
      });
      await expect(
        readFile(join(reader.workspacePath, "first", "revealed.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      const records = await readRawRecords(join(logDir, "issue-51-test-run.jsonl"));
      expect(records.filter((record) => record.type === "progressive_disclosure")).toEqual([
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["requested/revealed.txt", "requested/second-revealed.txt"],
          outcome: "unavailable",
          disclosed_paths: ["requested/revealed.txt"],
        }),
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["first/revealed.txt"],
          outcome: "unavailable",
          disclosed_paths: [],
        }),
      ]);
    } finally {
      forcedFilesystemFailure.onRename = undefined;
      await reader?.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("fails closed when a destination parent symlink would redirect disclosure through the isolated RPC path", async () => {
    const repository = await createRepository();
    let reader: IsolatedReader | null = null;
    try {
      const logDir = join(repository, "record-log");
      const log = new FileRecordLog({ baseDir: logDir });
      reader = await spawnIsolatedReader({ repository, progressiveDisclosure: true, log });
      const tools = await registerMachineTools(reader.machineToolsConfigPath);
      const outsidePath = join(repository, "outside-disclosure-target");
      const requestedPath = join(reader.workspacePath, "requested");
      const [primaryIndexPath, sparseCheckoutPath] = await Promise.all([
        gitPath(reader.workspacePath, "index"),
        gitPath(reader.workspacePath, "info/sparse-checkout"),
      ]);
      const [indexBeforeRequest, sparsePatternsBeforeRequest] = await Promise.all([
        readFile(primaryIndexPath),
        readFile(sparseCheckoutPath),
        mkdir(outsidePath),
      ]);
      await symlink(outsidePath, requestedPath, "dir");

      const unavailable = await requiredTool(tools, "request_files").execute(
        "issue-51-destination-symlink",
        {
          paths: ["requested/revealed.txt"],
          reason: "The declared dependency must not escape this role's projection.",
        },
        undefined,
        undefined,
        {},
      );

      expect(unavailable).toMatchObject({
        details: { outcome: "unavailable", code: "workspace-unavailable" },
        isError: true,
        terminate: false,
      });
      await expect(readFile(primaryIndexPath)).resolves.toEqual(indexBeforeRequest);
      await expect(readFile(sparseCheckoutPath)).resolves.toEqual(sparsePatternsBeforeRequest);
      expect((await lstat(requestedPath)).isSymbolicLink()).toBe(true);
      await expect(readFile(join(outsidePath, "revealed.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readThroughTool(tools, "requested/revealed.txt")).not.toContain(REVEALED_CANARY);
      const records = await readRawRecords(join(logDir, "issue-51-test-run.jsonl"));
      expect(records.filter((record) => record.type === "progressive_disclosure")).toEqual([
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["requested/revealed.txt"],
          reason: "The declared dependency must not escape this role's projection.",
          outcome: "unavailable",
          disclosed_paths: [],
        }),
      ]);
    } finally {
      await reader?.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("rolls back earlier disclosure parents when a later batch parent is unavailable through the isolated RPC path", async () => {
    const repository = await createRepository();
    let reader: IsolatedReader | null = null;
    try {
      const logDir = join(repository, "record-log");
      const log = new FileRecordLog({ baseDir: logDir });
      reader = await spawnIsolatedReader({ repository, progressiveDisclosure: true, log });
      const tools = await registerMachineTools(reader.machineToolsConfigPath);
      const [primaryIndexPath, sparseCheckoutPath] = await Promise.all([
        gitPath(reader.workspacePath, "index"),
        gitPath(reader.workspacePath, "info/sparse-checkout"),
      ]);
      const blockedParentPath = join(reader.workspacePath, "blocked");
      await writeFile(blockedParentPath, "pre-existing parent obstruction");
      const [indexBeforeRequest, sparsePatternsBeforeRequest] = await Promise.all([
        readFile(primaryIndexPath),
        readFile(sparseCheckoutPath),
      ]);

      const unavailable = await requiredTool(tools, "request_files").execute(
        "issue-51-batch-parent-unavailable",
        {
          paths: ["first/revealed.txt", "blocked/revealed.txt"],
          reason: "The declared dependencies must publish atomically.",
        },
        undefined,
        undefined,
        {},
      );

      expect(unavailable).toMatchObject({
        details: { outcome: "unavailable", code: "workspace-unavailable" },
        isError: true,
        terminate: false,
      });
      await expect(readFile(primaryIndexPath)).resolves.toEqual(indexBeforeRequest);
      await expect(readFile(sparseCheckoutPath)).resolves.toEqual(sparsePatternsBeforeRequest);
      await expect(lstat(join(reader.workspacePath, "first"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(blockedParentPath, "utf8")).resolves.toBe(
        "pre-existing parent obstruction",
      );
      expect(await rejectedReadMessage(tools, "first/revealed.txt")).not.toContain(
        FIRST_BATCH_CANARY,
      );
      expect(await rejectedReadMessage(tools, "blocked/revealed.txt")).not.toContain(
        BLOCKED_BATCH_CANARY,
      );
      const records = await readRawRecords(join(logDir, "issue-51-test-run.jsonl"));
      expect(records.filter((record) => record.type === "progressive_disclosure")).toEqual([
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["first/revealed.txt", "blocked/revealed.txt"],
          reason: "The declared dependencies must publish atomically.",
          outcome: "unavailable",
          disclosed_paths: [],
        }),
      ]);
    } finally {
      await reader?.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("removes every partially published file when later final publication fails through the isolated RPC path", async () => {
    const repository = await createRepository();
    let reader: IsolatedReader | null = null;
    let releaseFirstPublication: (() => void) | undefined;
    try {
      const logDir = join(repository, "record-log");
      const log = new FileRecordLog({ baseDir: logDir });
      reader = await spawnIsolatedReader({ repository, progressiveDisclosure: true, log });
      const tools = await registerMachineTools(reader.machineToolsConfigPath);
      const [primaryIndexPath, sparseCheckoutPath] = await Promise.all([
        gitPath(reader.workspacePath, "index"),
        gitPath(reader.workspacePath, "info/sparse-checkout"),
      ]);
      const [indexBeforeRequest, sparsePatternsBeforeRequest] = await Promise.all([
        readFile(primaryIndexPath),
        readFile(sparseCheckoutPath),
      ]);
      const firstDisclosedPath = join(reader.workspacePath, "requested", "revealed.txt");
      const secondDisclosedPath = join(reader.workspacePath, "requested", "second-revealed.txt");
      const firstPublished = new Promise<void>((resolvePromise) => {
        releaseFirstPublication = resolvePromise;
      });
      forcedFilesystemFailure.onRename = async (_sourcePath, destinationPath, renameFile) => {
        if (destinationPath === firstDisclosedPath) {
          await renameFile();
          releaseFirstPublication?.();
          return;
        }
        if (destinationPath === secondDisclosedPath) {
          await firstPublished;
          throw new Error("forced later final publication failure");
        }
        await renameFile();
      };

      const unavailable = await requiredTool(tools, "request_files").execute(
        "issue-51-later-final-publication-failure",
        {
          paths: ["requested/revealed.txt", "requested/second-revealed.txt"],
          reason: "The declared dependencies must publish atomically.",
        },
        undefined,
        undefined,
        {},
      );

      expect(unavailable).toMatchObject({
        details: { outcome: "unavailable", code: "workspace-unavailable" },
        isError: true,
        terminate: false,
      });
      await expect(readFile(primaryIndexPath)).resolves.toEqual(indexBeforeRequest);
      await expect(readFile(sparseCheckoutPath)).resolves.toEqual(sparsePatternsBeforeRequest);
      await expect(readFile(firstDisclosedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(secondDisclosedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(reader.workspacePath, "requested"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await rejectedReadMessage(tools, "requested/revealed.txt")).not.toContain(
        REVEALED_CANARY,
      );
      const records = await readRawRecords(join(logDir, "issue-51-test-run.jsonl"));
      expect(records.filter((record) => record.type === "progressive_disclosure")).toEqual([
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["requested/revealed.txt", "requested/second-revealed.txt"],
          reason: "The declared dependencies must publish atomically.",
          outcome: "unavailable",
          disclosed_paths: [],
        }),
      ]);
    } finally {
      releaseFirstPublication?.();
      forcedFilesystemFailure.onRename = undefined;
      await reader?.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("serializes concurrent bridged disclosures so an earlier failed publication cannot roll back a later approval", async () => {
    const repository = await createRepository();
    let reader: IsolatedReader | null = null;
    let releaseEarlierPublication: (() => void) | undefined;
    try {
      const logDir = join(repository, "record-log");
      const log = new FileRecordLog({ baseDir: logDir });
      reader = await spawnIsolatedReader({ repository, progressiveDisclosure: true, log });
      const tools = await registerMachineTools(reader.machineToolsConfigPath);
      const primaryIndexPath = await gitPath(reader.workspacePath, "index");
      const earlierDisclosedPath = join(reader.workspacePath, "first", "revealed.txt");
      const laterDisclosedPath = join(reader.workspacePath, "requested", "revealed.txt");
      let signalEarlierStageCommit: (() => void) | undefined;
      const earlierStageCommitted = new Promise<void>((resolvePromise) => {
        signalEarlierStageCommit = resolvePromise;
      });
      const earlierPublicationRelease = new Promise<void>((resolvePromise) => {
        releaseEarlierPublication = resolvePromise;
      });
      let indexCommitCount = 0;
      forcedFilesystemFailure.onRename = async (_sourcePath, destinationPath, renameFile) => {
        if (destinationPath === primaryIndexPath) {
          indexCommitCount += 1;
          await renameFile();
          if (indexCommitCount === 1) {
            signalEarlierStageCommit?.();
            await earlierPublicationRelease;
          }
          return;
        }
        if (destinationPath === earlierDisclosedPath) {
          throw new Error("forced earlier final publication failure");
        }
        await renameFile();
      };

      const requestFiles = requiredTool(tools, "request_files");
      const earlierRequest = requestFiles.execute(
        "issue-51-earlier-concurrent-failure",
        {
          paths: ["first/revealed.txt"],
          reason: "The first request is deliberately failed after staging commits.",
        },
        undefined,
        undefined,
        {},
      );
      await earlierStageCommitted;

      const laterRequest = requestFiles.execute(
        "issue-51-later-concurrent-approval",
        {
          paths: ["requested/revealed.txt"],
          reason: "The independent declared dependency must remain available.",
        },
        undefined,
        undefined,
        {},
      );
      const laterCompletedBeforeEarlierFailure = await completesWithin(laterRequest, 1_000);
      releaseEarlierPublication?.();
      releaseEarlierPublication = undefined;
      const [earlierResult, laterResult] = await Promise.all([earlierRequest, laterRequest]);

      expect(laterCompletedBeforeEarlierFailure).toBe(false);
      expect(earlierResult).toMatchObject({
        details: { outcome: "unavailable", code: "workspace-unavailable" },
        isError: true,
        terminate: false,
      });
      expect(laterResult).toMatchObject({
        details: {
          outcome: "approved",
          disclosed_paths: ["requested/revealed.txt"],
        },
        isError: false,
        terminate: false,
      });
      expect(await readThroughTool(tools, "requested/revealed.txt")).toContain(REVEALED_CANARY);
      await expect(
        readFile(join(reader.workspacePath, "requested", "hidden-sibling.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(earlierDisclosedPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      const records = await readRawRecords(join(logDir, "issue-51-test-run.jsonl"));
      expect(records.filter((record) => record.type === "progressive_disclosure")).toEqual([
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["first/revealed.txt"],
          reason: "The first request is deliberately failed after staging commits.",
          outcome: "unavailable",
          disclosed_paths: [],
        }),
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["requested/revealed.txt"],
          reason: "The independent declared dependency must remain available.",
          outcome: "approved",
          disclosed_paths: ["requested/revealed.txt"],
        }),
      ]);
      await expect(readFile(laterDisclosedPath, "utf8")).resolves.toContain(REVEALED_CANARY);
    } finally {
      releaseEarlierPublication?.();
      forcedFilesystemFailure.onRename = undefined;
      await reader?.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("restores the primary projection when read-only establishment fails through the isolated RPC path", async () => {
    const repository = await createRepository();
    let reader: IsolatedReader | null = null;
    try {
      const logDir = join(repository, "record-log");
      const log = new FileRecordLog({ baseDir: logDir });
      reader = await spawnIsolatedReader({
        repository,
        progressiveDisclosure: true,
        writable: false,
        log,
      });
      const tools = await registerMachineTools(reader.machineToolsConfigPath);
      const [primaryIndexPath, sparseCheckoutPath] = await Promise.all([
        gitPath(reader.workspacePath, "index"),
        gitPath(reader.workspacePath, "info/sparse-checkout"),
      ]);
      const [indexBeforeRequest, sparsePatternsBeforeRequest] = await Promise.all([
        readFile(primaryIndexPath),
        readFile(sparseCheckoutPath),
      ]);
      const disclosedPath = join(reader.workspacePath, "requested", "revealed.txt");
      forcedFilesystemFailure.onChmod = async () => {
        throw new Error("forced read-only establishment failure");
      };

      const unavailable = await requiredTool(tools, "request_files").execute(
        "issue-51-read-only-establishment-failure",
        {
          paths: ["requested/revealed.txt"],
          reason: "The visible task input requires this declared dependency.",
        },
        undefined,
        undefined,
        {},
      );

      expect(unavailable).toMatchObject({
        details: { outcome: "unavailable", code: "workspace-unavailable" },
        isError: true,
        terminate: false,
      });
      await expect(readFile(primaryIndexPath)).resolves.toEqual(indexBeforeRequest);
      await expect(readFile(sparseCheckoutPath)).resolves.toEqual(sparsePatternsBeforeRequest);
      await expect(readFile(disclosedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await rejectedReadMessage(tools, "requested/revealed.txt")).not.toContain(
        REVEALED_CANARY,
      );
      expect(await readThroughTool(tools, "selected/visible.txt")).toContain(SELECTED_CANARY);
      const records = await readRawRecords(join(logDir, "issue-51-test-run.jsonl"));
      expect(records.filter((record) => record.type === "progressive_disclosure")).toEqual([
        expect.objectContaining({
          role: READER,
          visit_index: 1,
          requested_paths: ["requested/revealed.txt"],
          reason: "The visible task input requires this declared dependency.",
          outcome: "unavailable",
          disclosed_paths: [],
        }),
      ]);
    } finally {
      forcedFilesystemFailure.onChmod = undefined;
      await reader?.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("never exposes a newly disclosed file while it is writable", async () => {
    const repository = await createRepository();
    let reader: IsolatedReader | null = null;
    let releaseChmod: (() => void) | undefined;
    try {
      reader = await spawnIsolatedReader({
        repository,
        progressiveDisclosure: true,
        writable: false,
      });
      const tools = await registerMachineTools(reader.machineToolsConfigPath);
      let signalChmodAttempt: (() => void) | undefined;
      const chmodAttempted = new Promise<void>((resolvePromise) => {
        signalChmodAttempt = resolvePromise;
      });
      const chmodRelease = new Promise<void>((resolvePromise) => {
        releaseChmod = resolvePromise;
      });
      forcedFilesystemFailure.onChmod = async () => {
        signalChmodAttempt?.();
        await chmodRelease;
        throw new Error("forced read-only establishment failure");
      };

      const request = requiredTool(tools, "request_files").execute(
        "issue-51-read-only-race",
        {
          paths: ["requested/revealed.txt"],
          reason: "The visible task input requires this declared dependency.",
        },
        undefined,
        undefined,
        {},
      );
      await chmodAttempted;
      const concurrentRead = readThroughTool(tools, "requested/revealed.txt").then(
        (content) => ({ kind: "read" as const, content }),
        (error: unknown) => ({
          kind: "rejected" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      const release = releaseChmod;
      if (release === undefined) throw new Error("read-only establishment did not block at chmod");
      forcedFilesystemFailure.releaseBlockedChmod = release;
      release();
      releaseChmod = undefined;
      forcedFilesystemFailure.releaseBlockedChmod = undefined;
      const [unavailable, concurrentReadResult] = await Promise.all([request, concurrentRead]);

      expect(concurrentReadResult).toMatchObject({ kind: "rejected" });
      if (concurrentReadResult.kind === "rejected") {
        expect(concurrentReadResult.message).not.toContain(REVEALED_CANARY);
      }
      expect(unavailable).toMatchObject({
        details: { outcome: "unavailable", code: "workspace-unavailable" },
        isError: true,
        terminate: false,
      });
      await expect(
        readFile(join(reader.workspacePath, "requested", "revealed.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseChmod?.();
      forcedFilesystemFailure.onChmod = undefined;
      await reader?.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("keeps the progressive projection sparse without the request_files role tool opt-in", async () => {
    const repository = await createRepository();
    let reader: IsolatedReader | null = null;
    try {
      reader = await spawnIsolatedReader({
        repository,
        progressiveDisclosure: true,
        requestFiles: false,
      });
      const tools = await registerMachineTools(reader.machineToolsConfigPath);

      expect([...tools.keys()].sort()).toEqual(["end", "handoff", "read", "write"]);
      expect(reader.requestFilesBridgeProvisioned).toBe(false);
      expect(await readThroughTool(tools, "selected/visible.txt")).toContain(SELECTED_CANARY);
      await expect(
        readFile(join(reader.workspacePath, "requested", "revealed.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(join(reader.workspacePath, "sibling", "secret.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await reader?.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("retains the existing complete worktree projection without the opt-in policy", async () => {
    const repository = await createRepository();
    let reader: IsolatedReader | null = null;
    try {
      reader = await spawnIsolatedReader({ repository, progressiveDisclosure: false });
      const tools = await registerMachineTools(reader.machineToolsConfigPath);

      expect(await readFile(join(reader.workspacePath, "sibling", "secret.txt"), "utf8")).toContain(
        SIBLING_CANARY,
      );
      expect(await readThroughTool(tools, "sibling/secret.txt")).toContain(SIBLING_CANARY);
      expect(tools.has("request_files")).toBe(false);
    } finally {
      await reader?.dispose();
      await rm(repository, { recursive: true, force: true });
    }
  });
});

async function poisonWorkspaceGitPointer(options: {
  readonly repository: string;
  readonly reader: IsolatedReader;
}): Promise<PoisonedGitPointer> {
  const alternateWorkspacePath = join(options.repository, "alternate-worktree");
  await runGit(options.repository, ["worktree", "add", "--detach", alternateWorkspacePath, "HEAD"]);
  await runGit(alternateWorkspacePath, ["sparse-checkout", "set", "--no-cone", "--", "selected"]);

  const readerGitPointerPath = join(options.reader.workspacePath, ".git");
  const [readerGitPointer, alternateGitPointer, alternateIndexPath, alternateSparsePath] =
    await Promise.all([
      readFile(readerGitPointerPath, "utf8"),
      readFile(join(alternateWorkspacePath, ".git"), "utf8"),
      gitPath(alternateWorkspacePath, "index"),
      gitPath(alternateWorkspacePath, "info/sparse-checkout"),
    ]);
  const [alternateIndex, alternateSparse] = await Promise.all([
    readFile(alternateIndexPath),
    readFile(alternateSparsePath),
  ]);
  await expect(
    readFile(join(alternateWorkspacePath, "requested", "revealed.txt"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(readerGitPointerPath, alternateGitPointer);

  return {
    restore: () => writeFile(readerGitPointerPath, readerGitPointer),
    expectUntouched: async () => {
      await expect(readFile(alternateIndexPath)).resolves.toEqual(alternateIndex);
      await expect(readFile(alternateSparsePath)).resolves.toEqual(alternateSparse);
      await expect(
        readFile(join(alternateWorkspacePath, "requested", "revealed.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  };
}

async function gitPath(workspacePath: string, path: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", path], {
    cwd: workspacePath,
  });
  const gitPath = stdout.trim();
  return isAbsolute(gitPath) ? gitPath : resolve(workspacePath, gitPath);
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "pi-conductor-issue-51-"));
  await mkdir(join(repository, "selected"), { recursive: true });
  await mkdir(join(repository, "requested"), { recursive: true });
  await mkdir(join(repository, "first"), { recursive: true });
  await mkdir(join(repository, "blocked"), { recursive: true });
  await mkdir(join(repository, "sibling"), { recursive: true });
  await writeFile(join(repository, "selected", "visible.txt"), SELECTED_CANARY);
  await writeFile(join(repository, "requested", "revealed.txt"), REVEALED_CANARY);
  await writeFile(join(repository, "requested", "second-revealed.txt"), "second-revealed-canary");
  await writeFile(join(repository, "requested", "hidden-sibling.txt"), REQUESTED_SIBLING_CANARY);
  await writeFile(join(repository, "first", "revealed.txt"), FIRST_BATCH_CANARY);
  await writeFile(join(repository, "blocked", "revealed.txt"), BLOCKED_BATCH_CANARY);
  await writeFile(join(repository, "sibling", "secret.txt"), SIBLING_CANARY);
  await runGit(repository, ["init"]);
  await runGit(repository, ["config", "user.email", "issue-51@example.test"]);
  await runGit(repository, ["config", "user.name", "Issue 51 Test"]);
  await runGit(repository, ["add", "."]);
  await runGit(repository, ["commit", "-m", "test fixture"]);
  return repository;
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function spawnIsolatedReader(options: {
  readonly repository: string;
  readonly progressiveDisclosure: boolean;
  readonly requestFiles?: boolean;
  readonly writable?: boolean;
  readonly log?: InMemoryRecordLog | FileRecordLog;
}): Promise<IsolatedReader> {
  let machineToolsConfigPath: string | null = null;
  let workspacePath: string | null = null;
  let requestFilesBridgeProvisioned: boolean | null = null;
  const [{ ProductionHost }, { createNodeRoleSession }] = await Promise.all([
    import("../../src/index.js"),
    import("../../src/host/rpc/node-role-session-factory.js"),
  ]);
  const host = new ProductionHost({
    modelRegistry: makeModelRegistryWithStub(),
    cwd: options.repository,
    log: options.log ?? new InMemoryRecordLog(),
    loadedManifest: loadManifestFromString(
      readerManifest(
        options.progressiveDisclosure,
        options.requestFiles ?? true,
        options.writable ?? true,
      ),
    ),
    runId: "issue-51-test-run",
    sessionDir: join(options.repository, "role-sessions"),
    agentDir: join(options.repository, "agent"),
    nodeRoleSessionFactory: async (nodeOptions) => {
      machineToolsConfigPath = nodeOptions.machineToolsConfigPath;
      workspacePath = nodeOptions.cwd;
      requestFilesBridgeProvisioned = nodeOptions.requestFilesBridge !== undefined;
      const child = new HostFakeRpcChild();
      const starting = createNodeRoleSession({ ...nodeOptions, spawn: () => child });
      child.success(child.command("get_state"), {
        sessionId: "issue-51-reader-session",
        sessionFile: join(nodeOptions.sessionDir, "issue-51-reader-session.jsonl"),
      });
      const session = await starting;
      child.stdin.onWrite = (write) => {
        const command = JSON.parse(write) as Record<string, unknown>;
        if (command.type === "abort") child.success(command);
      };
      return session;
    },
  });

  const session = await host.spawnRole(READER, { visitIndex: 1 });
  if (
    machineToolsConfigPath === null ||
    workspacePath === null ||
    requestFilesBridgeProvisioned === null
  ) {
    throw new Error("ProductionHost did not provide an isolated RPC workspace configuration");
  }
  return {
    workspacePath,
    machineToolsConfigPath,
    requestFilesBridgeProvisioned,
    dispose: () => session.dispose(),
  };
}

function readerManifest(
  progressiveDisclosure: boolean,
  requestFiles: boolean,
  writable: boolean,
): string {
  const policy = progressiveDisclosure
    ? `
      progressive_disclosure:
        initial_paths: [selected]
        allowed_paths: [selected, requested, first, blocked]`
    : "";
  return `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
  - name: reader
    max_visits: 1
    models:
      - model: stub:stub-model
        effort: max
    tools: [read${writable ? ", write" : ""}${requestFiles ? ", request_files" : ""}, handoff, end]
    workspace:
      backend: worktree${policy}
`;
}

async function registerMachineTools(
  machineToolsConfigPath: string,
): Promise<Map<string, RegisteredTool>> {
  const { default: machineToolsExtension } = await import(
    "../../src/host/rpc/machine-tools-extension.js"
  );
  const registered = new Map<string, RegisteredTool>();
  const originalConfigPath = process.env[MACHINE_TOOLS_CONFIG_ENV];
  process.env[MACHINE_TOOLS_CONFIG_ENV] = machineToolsConfigPath;
  try {
    machineToolsExtension({
      registerTool(tool) {
        registered.set(tool.name, tool as unknown as RegisteredTool);
      },
    } as ExtensionAPI);
  } finally {
    if (originalConfigPath === undefined) {
      delete process.env[MACHINE_TOOLS_CONFIG_ENV];
    } else {
      process.env[MACHINE_TOOLS_CONFIG_ENV] = originalConfigPath;
    }
  }
  return registered;
}

function requiredTool(tools: ReadonlyMap<string, RegisteredTool>, name: string): RegisteredTool {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`isolated machine tools did not register ${name}`);
  return tool;
}

async function readThroughTool(
  tools: ReadonlyMap<string, RegisteredTool>,
  path: string,
): Promise<string> {
  const result = await requiredTool(tools, "read").execute(
    "issue-51-read",
    { path },
    undefined,
    undefined,
    {},
  );
  return JSON.stringify(result.content);
}

async function rejectedReadMessage(
  tools: ReadonlyMap<string, RegisteredTool>,
  path: string,
): Promise<string> {
  try {
    await readThroughTool(tools, path);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`read unexpectedly succeeded for '${path}'`);
}

async function rejectedWriteMessage(
  tools: ReadonlyMap<string, RegisteredTool>,
  path: string,
  content: string,
): Promise<string> {
  try {
    const result = await requiredTool(tools, "write").execute(
      "issue-51-disclosed-write",
      { path, content },
      undefined,
      undefined,
      {},
    );
    if (result.isError === true) return JSON.stringify(result.content);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`write unexpectedly succeeded for '${path}'`);
}

async function completesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolvePromise) => {
        timeout = setTimeout(() => resolvePromise(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function readRawRecords(path: string): Promise<readonly Record<string, unknown>[]> {
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}
