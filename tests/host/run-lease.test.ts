/** Issue #48 R2 FileRecordLog live-execution lease behavior. */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { FileRecordLog } from "../../src/index.js";

let baseDir: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (baseDir !== undefined) {
    await rm(baseDir, { force: true, recursive: true });
    baseDir = undefined;
  }
});

describe("FileRecordLog live execution leases (Issue #48 R2a)", () => {
  it("releases a loopback lease when a client keeps its connection open, then permits reacquisition", async () => {
    baseDir = await mkdtemp(join(tmpdir(), "pi-conductor-lease-held-client-"));
    const runId = "held-client";
    const log = new FileRecordLog({ baseDir });
    const lease = await log.acquireRunLease(runId);
    const client = createConnection({
      host: "127.0.0.1",
      port: firstLeaseCandidate(baseDir, runId),
      allowHalfOpen: true,
    });
    // The retained client is deliberately not closed until after release.
    client.on("error", () => undefined);

    try {
      await expect(readLeaseIdentity(client)).resolves.toBe(leaseIdentity(baseDir, runId));
      await expect(completesWithin(lease.release())).resolves.toBeUndefined();

      const reacquired = await log.acquireRunLease(runId);
      await reacquired.release();
    } finally {
      client.destroy();
      await lease.release();
    }
  });

  it("returns a typed unavailable error after its bounded candidates are all occupied", async () => {
    baseDir = await mkdtemp(join(tmpdir(), "pi-conductor-lease-exhausted-"));
    const runId = "exhausted";
    const servers: Server[] = [];

    try {
      for (const port of leaseCandidates(baseDir, runId)) {
        const server = createServer((socket) => socket.end("foreign-run\\n"));
        await listenOnLoopback(server, port);
        servers.push(server);
      }

      await expect(new FileRecordLog({ baseDir }).acquireRunLease(runId)).rejects.toMatchObject({
        name: "RunLeaseUnavailableError",
        code: "run-lease-unavailable",
      });
    } finally {
      await Promise.all(servers.map((server) => closeTestServer(server)));
    }
  });

  const foreignListenerCases: readonly {
    readonly name: string;
    readonly onConnection: (socket: Socket) => Promise<void> | undefined;
  }[] = [
    {
      name: "a different lease identity",
      onConnection: (socket) => {
        socket.end("other-run\\n");
        return undefined;
      },
    },
    {
      name: "an unresponsive listener",
      onConnection: (socket) => {
        socket.on("error", () => undefined);
        return undefined;
      },
    },
    {
      name: "a malformed byte-dripping listener",
      onConnection: (socket) =>
        new Promise((resolve) => {
          let stopped = false;
          const interval = setInterval(() => socket.write("x"), 10);
          const stopWriter = () => {
            if (stopped) return;
            stopped = true;
            clearInterval(interval);
            resolve();
          };
          socket.once("error", stopWriter);
          socket.once("close", stopWriter);
        }),
    },
  ];

  for (const { name, onConnection } of foreignListenerCases) {
    it(`skips an occupied first candidate owned by ${name}`, async () => {
      baseDir = await mkdtemp(join(tmpdir(), "pi-conductor-lease-foreign-occupant-"));
      const runId = "foreign-occupant";
      let connectionCount = 0;
      let writerStopped: Promise<void> | undefined;
      const server = createServer((socket) => {
        connectionCount += 1;
        writerStopped = onConnection(socket);
      });
      await listenOnLoopback(server, firstLeaseCandidate(baseDir, runId));

      const acquisition = new FileRecordLog({ baseDir }).acquireRunLease(runId);
      try {
        const lease = await completesWithin(acquisition, 500);
        await lease.release();
        expect(connectionCount).toBeGreaterThan(0);
        if (writerStopped !== undefined) {
          await expect(completesWithin(writerStopped, 500)).resolves.toBeUndefined();
        }
      } finally {
        await acquisition.then(
          (lease) => lease.release(),
          () => undefined,
        );
        await closeTestServer(server);
      }
    });
  }
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

function leaseIdentity(baseDir: string, runId: string): string {
  return `pi-conductor-run-lease-v1:${createHash("sha256")
    .update(realpathSync(baseDir))
    .update("\0")
    .update(runId)
    .digest("hex")}`;
}

function leaseCandidates(baseDir: string, runId: string): readonly number[] {
  const digest = createHash("sha256")
    .update(realpathSync(baseDir))
    .update("\0")
    .update(runId)
    .digest();
  const offset = digest.readUInt32BE(0) % LEASE_PORT_COUNT;
  const stride = (digest.readUInt32BE(4) % LEASE_PORT_COUNT) | 1;
  return Array.from(
    { length: 64 },
    (_, index) => LEASE_PORT_START + ((offset + index * stride) % LEASE_PORT_COUNT),
  );
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

function completesWithin<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("lease operation did not complete")),
      timeoutMs,
    );
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

function listenOnLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (cause: Error) => {
      server.off("listening", onListening);
      reject(cause);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port });
  });
}

function closeTestServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) {
        resolve();
        return;
      }
      reject(cause);
    });
  });
}
