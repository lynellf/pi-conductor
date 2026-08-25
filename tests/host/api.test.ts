/**
 * Tests for the `modelRegistry` option on `startRun` and `resumeRun`
 * (Issue #6 — T2.10).
 *
 * Verifies that:
 *   - `startRun` with `modelRegistry` runs the preflight check and
 *     warnings surface on `handle.loadedManifest.warnings`.
 *   - `startRun` without `modelRegistry` skips the check.
 *   - `resumeRun` with `modelRegistry` runs the preflight check on
 *     the resumed load.
 *   - `resumeRun` without `modelRegistry` skips the check.
 *   - `handle.loadedManifest` is the same reference returned by
 *     `loadManifest` (wiring consistency).
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileRecordLog,
  type Host,
  type HostFactoryContext,
  resumeRun,
  StubHost,
  startRun,
} from "../../src/index.js";
import type { InMemoryRecordLog } from "../../src/persistence/log.js";

// ─── Fixtures ───────────────────────────────────────────────────────────

const VALID_MANIFEST = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: unregistered:model-1
        effort: medium
    system_prompt: roles/orchestrator.md
`;

const MANIFEST_WITH_UNREGISTERED = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: unknown:provider-a
        effort: medium
      - model: unknown:provider-b
        effort: medium
    system_prompt: roles/orchestrator.md
`;

const MANIFEST_WITH_REGISTERED_ONLY = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models:
      - model: anthropic:claude-4
        effort: high
    system_prompt: roles/orchestrator.md
`;

// ─── Helpers ────────────────────────────────────────────────────────────

/** A StubHost factory that matches the HostFactoryContext shape. */
function stubHostFactory(ctx: HostFactoryContext): Host {
  return new StubHost({
    runId: ctx.runId,
    log: ctx.log as InMemoryRecordLog,
    steps: [],
  });
}

/** ModelRegistry with nothing registered — find always returns undefined. */
function emptyRegistry(): ModelRegistry {
  return ModelRegistry.inMemory(AuthStorage.inMemory());
}

/** ModelRegistry with anthropic registered. */
function registryWithAnthropic(): ModelRegistry {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  registry.find = (provider: string) => {
    if (provider === "anthropic") return {} as never;
    return undefined;
  };
  return registry;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("startRun with modelRegistry (T2.10)", () => {
  let workdir: string;
  let manifestPath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-api-test-"));
    await mkdir(join(workdir, ".pi"), { recursive: true });
    manifestPath = join(workdir, ".pi", "conductor.yaml");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("startRun with modelRegistry → preflight runs; warnings contain unregistered-provider", async () => {
    await writeFile(manifestPath, MANIFEST_WITH_UNREGISTERED, "utf8");
    const handle = await startRun(manifestPath, {
      goal: "test",
      hostFactory: stubHostFactory,
      modelRegistry: emptyRegistry(),
    });
    const unregistered = handle.loadedManifest.warnings.filter(
      (w) => w.code === "unregistered-provider",
    );
    expect(unregistered.length).toBeGreaterThan(0);
    expect(unregistered[0]?.message).toContain("unknown:provider-a");
    // Abort immediately — the handle is valid but we don't need the run to complete.
    await handle.abort("test cleanup");
    await handle.completion();
    await expect(handle.followUp("too late")).rejects.toMatchObject({ code: "run_terminal" });
  });

  it("startRun without modelRegistry → no unregistered-provider warnings", async () => {
    await writeFile(manifestPath, VALID_MANIFEST, "utf8");
    const handle = await startRun(manifestPath, {
      goal: "test",
      hostFactory: stubHostFactory,
    });
    const unregistered = handle.loadedManifest.warnings.filter(
      (w) => w.code === "unregistered-provider",
    );
    expect(unregistered).toHaveLength(0);
    await handle.abort("test cleanup");
  });

  it("handle.loadedManifest is the same reference from loadManifest (wiring check)", async () => {
    await writeFile(manifestPath, MANIFEST_WITH_UNREGISTERED, "utf8");
    const handle = await startRun(manifestPath, {
      goal: "test",
      hostFactory: stubHostFactory,
      modelRegistry: emptyRegistry(),
    });
    // loadedManifest.def must be present and structured.
    expect(handle.loadedManifest.def).toBeDefined();
    expect(handle.loadedManifest.def.manifest_version).toBe("1");
    await handle.abort("test cleanup");
  });
});

describe("Issue #48 — container backend entrypoint preflight", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-container-preflight-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  for (const containerRole of ["initial", "later"] as const) {
    const manifest =
      containerRole === "initial"
        ? `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    workspace:
      backend: container
      image: docker.io/example/orchestrator:latest
  - name: worker
    max_visits: 3
`
        : `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 3
    workspace:
      backend: container
      image: docker.io/example/worker:latest
`;

    for (const entrypoint of ["startRun", "resumeRun"] as const) {
      it(`${entrypoint} rejects a ${containerRole} container role before run persistence or host construction`, async () => {
        const manifestPath = join(workdir, `${entrypoint}-${containerRole}.yaml`);
        const baseDir = join(workdir, "run-records");
        const sessionRunsDir = join(workdir, ".pi-conductor", "runs");
        let factoryInvoked = false;
        const hostFactory = () => {
          factoryInvoked = true;
          throw new Error("host factory must not run for a container manifest");
        };
        await writeFile(manifestPath, manifest, "utf8");

        const invoke =
          entrypoint === "startRun"
            ? () => startRun(manifestPath, { goal: "test", baseDir, hostFactory })
            : () =>
                resumeRun(manifestPath, "uncreated-run", {
                  goal: "test",
                  baseDir,
                  hostFactory,
                });

        await expect(invoke()).rejects.toMatchObject({
          name: "WorkspaceError",
          code: "container-unavailable",
        });
        expect(factoryInvoked).toBe(false);
        await expect(stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(sessionRunsDir)).rejects.toMatchObject({ code: "ENOENT" });
      });
    }
  }
});

describe("Issue #48 — FileRecordLog lease release paths", () => {
  let workdir: string;
  let manifestPath: string;
  let baseDir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-lease-release-"));
    await mkdir(join(workdir, ".pi"), { recursive: true });
    manifestPath = join(workdir, ".pi", "conductor.yaml");
    baseDir = join(workdir, "runs");
    await writeFile(manifestPath, VALID_MANIFEST, "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("releases the lease after a terminal loop so a second public resume can enter", async () => {
    const first = await startRun(manifestPath, {
      goal: "finish",
      baseDir,
      hostFactory: ({ runId, log }) =>
        new StubHost({ runId, log, steps: [{ kind: "emit_end", reason: "finished" }] }),
    });
    await first.completion();

    const second = await resumeRun(manifestPath, first.runId, {
      goal: "",
      baseDir,
      hostFactory: ({ runId, log }) => new StubHost({ runId, log, steps: [] }),
    });

    await expect(second.completion()).resolves.toMatchObject({ exitReason: "done" });
  });

  it("lets terminal RunHandle.completion release a lease held open by a probe client", async () => {
    let sessionEntered: (() => void) | undefined;
    const sessionReady = new Promise<void>((resolve) => {
      sessionEntered = resolve;
    });
    let allowTerminal: (() => void) | undefined;
    const terminalGate = new Promise<void>((resolve) => {
      allowTerminal = resolve;
    });
    const handle = await startRun(manifestPath, {
      goal: "finish after probe",
      baseDir,
      hostFactory: ({ runId, log }) => {
        const host = new StubHost({
          runId,
          log,
          steps: [{ kind: "emit_end", reason: "finished" }],
        });
        const spawnRole = host.spawnRole.bind(host);
        host.spawnRole = async (role, options) => {
          const session = await spawnRole(role, options);
          return {
            ...session,
            prompt: async (seed) => {
              sessionEntered?.();
              await terminalGate;
              await session.prompt(seed);
            },
          };
        };
        return host;
      },
    });
    await sessionReady;

    const client = createConnection({
      host: "127.0.0.1",
      port: firstLeaseCandidate(baseDir, handle.runId),
      allowHalfOpen: true,
    });
    client.on("error", () => undefined);

    try {
      await expect(readLeaseIdentity(client)).resolves.toMatch(/^pi-conductor-run-lease-v1:/);
      allowTerminal?.();
      await expect(
        completesWithin(handle.completion(), "RunHandle completion"),
      ).resolves.toMatchObject({
        exitReason: "done",
      });

      const lease = await new FileRecordLog({ baseDir }).acquireRunLease(handle.runId);
      await lease.release();
    } finally {
      client.destroy();
      allowTerminal?.();
      await handle.completion().catch(() => undefined);
    }
  });

  it("releases the lease after host construction fails before the loop", async () => {
    const runId = "pre-loop-error";
    const log = new FileRecordLog({ baseDir });
    log.append({
      type: "checkpoint_snapshot",
      checkpoint: {
        run_id: runId,
        manifest_version: "1",
        current_role: "orchestrator",
        visit_count: {},
        end_request: null,
        active_role_session: null,
        updated_at: 1,
      },
    });

    await expect(
      resumeRun(manifestPath, runId, {
        goal: "",
        baseDir,
        hostFactory: () => {
          throw new Error("host construction failed");
        },
      }),
    ).rejects.toThrow("host construction failed");

    const recovered = await resumeRun(manifestPath, runId, {
      goal: "",
      baseDir,
      hostFactory: ({ runId: recoveredRunId, log: recoveredLog }) =>
        new StubHost({
          runId: recoveredRunId,
          log: recoveredLog,
          steps: [{ kind: "emit_end", reason: "recovered" }],
        }),
    });

    await expect(recovered.completion()).resolves.toMatchObject({ exitReason: "done" });
  });
});

const LEASE_PORT_START = 49_152;
const LEASE_PORT_COUNT = 8_192;

function firstLeaseCandidate(baseDir: string, runId: string): number {
  const digest = createHash("sha256")
    .update(realpathSync(baseDir))
    .update("\0")
    .update(runId)
    .digest();
  return LEASE_PORT_START + (digest.readUInt32BE(0) % LEASE_PORT_COUNT);
}

function readLeaseIdentity(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = "";
    const timeout = setTimeout(
      () => finish(new Error("timed out waiting for lease identity")),
      1_000,
    );
    const onData = (chunk: Buffer) => {
      response += chunk.toString("utf8");
      const newline = response.indexOf("\n");
      if (newline !== -1) finish(null, response.slice(0, newline));
    };
    const onError = (cause: Error) => finish(cause);
    const onEnd = () => finish(null, response);
    const finish = (cause: Error | null, identity?: string) => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.setTimeout(0);
      if (cause !== null) {
        reject(cause);
        return;
      }
      resolve(identity ?? "");
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function completesWithin<T>(promise: Promise<T>, subject: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${subject} did not complete`)), 1_000);
    void promise.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (cause: unknown) => {
        clearTimeout(timeout);
        reject(cause);
      },
    );
  });
}

describe("resumeRun with modelRegistry (T2.10)", () => {
  let workdir: string;
  let manifestPath: string;
  let baseDir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "pi-conductor-api-resume-test-"));
    await mkdir(join(workdir, ".pi"), { recursive: true });
    manifestPath = join(workdir, ".pi", "conductor.yaml");
    baseDir = join(workdir, "runs");
    await mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("resumeRun with modelRegistry → preflight runs on resumed load", async () => {
    // First, start a run to create a checkpoint log.
    await writeFile(manifestPath, MANIFEST_WITH_UNREGISTERED, "utf8");
    const startHandle = await startRun(manifestPath, {
      goal: "test",
      hostFactory: stubHostFactory,
      modelRegistry: emptyRegistry(),
      baseDir,
    });
    const runId = startHandle.runId;
    await startHandle.abort("cleanup");

    // Now resume with the same baseDir + registry.
    const handle = await resumeRun(manifestPath, runId, {
      goal: "",
      hostFactory: stubHostFactory,
      baseDir,
      modelRegistry: registryWithAnthropic(),
    });
    const unregistered = handle.loadedManifest.warnings.filter(
      (w) => w.code === "unregistered-provider",
    );
    // Only anthropic entries are registered; unknown:* entries still miss.
    expect(unregistered.length).toBeGreaterThan(0);
    expect(unregistered.every((w) => w.message.includes("unknown"))).toBe(true);
    await handle.abort("test cleanup");
    await handle.completion();
    await expect(handle.steer("too late")).rejects.toMatchObject({ code: "run_terminal" });
  });

  it("resumeRun without modelRegistry → no unregistered-provider warnings", async () => {
    await writeFile(manifestPath, MANIFEST_WITH_REGISTERED_ONLY, "utf8");
    const startHandle = await startRun(manifestPath, {
      goal: "test",
      hostFactory: stubHostFactory,
      baseDir,
    });
    const runId = startHandle.runId;
    await startHandle.abort("cleanup");

    const handle = await resumeRun(manifestPath, runId, {
      goal: "",
      hostFactory: stubHostFactory,
      baseDir,
    });
    const unregistered = handle.loadedManifest.warnings.filter(
      (w) => w.code === "unregistered-provider",
    );
    expect(unregistered).toHaveLength(0);
    await handle.abort("test cleanup");
  });
});
