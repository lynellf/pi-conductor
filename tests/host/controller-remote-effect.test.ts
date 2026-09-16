import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type EffectGrant,
  pinEffectAuthority,
  type SupportedEffectImplementation,
} from "../../src/host/controller/effect-registry.js";
import {
  executeRemoteEffect,
  readProtectedCredentialFile,
  reconcileRemoteEffect,
} from "../../src/host/controller/remote-effect.js";
import {
  type DeliverRefRequest,
  effectRequestSchemaDigest,
  effectResultSchemaDigest,
} from "../../src/manifest/controller-effect.js";

const sha = (character: string) => character.repeat(64);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const implementation: SupportedEffectImplementation = {
  id: "builtin-deliver-ref-v1",
  kind: "deliver_ref",
  digest: sha("1"),
  request_schema_id: "deliver-ref-request-v1",
  request_schema_digest: effectRequestSchemaDigest("deliver_ref"),
  output_schema_id: "deliver-ref-result-v1",
  output_schema_digest: effectResultSchemaDigest("deliver_ref"),
};

const effectRequest: DeliverRefRequest = {
  schema_version: 1,
  kind: "deliver_ref",
  repository_id: "repo-main",
  source_ref: "refs/pi-conductor/integration/reviewed",
  reviewed_head: sha("2"),
  remote_id: "fake-service",
  target_ref: "refs/heads/main",
  expected_remote_oid: sha("3"),
  idempotency_key: "delivery-17",
  evidence: [
    {
      artifact_ref: "artifact/v2/validation",
      sha256: sha("4"),
      producer_id: "validate-integrated",
      schema_id: "validation-v1",
      subject_head: sha("2"),
      verdict: "approved",
    },
  ],
};

const effectResult = {
  schema_version: 1 as const,
  kind: "deliver_ref" as const,
  repository_id: "repo-main",
  remote_id: "fake-service",
  target_ref: "refs/heads/main",
  reviewed_head: sha("2"),
  prior_remote_oid: sha("3"),
  remote_object_oid: sha("2"),
  idempotency_key: "delivery-17",
};

function createCredential(mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), "remote-effect-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "credential");
  writeFileSync(path, "test-secret", { mode });
  return path;
}

async function withService<T>(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (origin: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test address");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

function authority(origin: string, method: "PUT" | "POST" = "PUT") {
  const grant: EffectGrant = {
    schema_version: 1,
    id: "deliver-reviewed",
    adapter_id: "choose-delivery",
    kind: "deliver_ref",
    implementation_id: implementation.id,
    implementation_digest: implementation.digest,
    request_schema_id: implementation.request_schema_id,
    request_schema_digest: implementation.request_schema_digest,
    output_schema_id: implementation.output_schema_id,
    output_schema_digest: implementation.output_schema_digest,
    repository: { id: "repo-main", canonical_path: "/srv/repos/project", fingerprint: sha("5") },
    remote: {
      id: "fake-service",
      exact_origin: origin,
      exact_path: "/v1/delivery",
      method,
      credential_source_id: "delivery-token",
    },
    allowed_source_refs: ["refs/pi-conductor/integration/reviewed"],
    allowed_target_refs: ["refs/heads/main"],
    required_evidence: [{ producer_id: "validate-integrated", schema_id: "validation-v1" }],
    max_input_bytes: 65_536,
    max_output_bytes: 65_536,
    timeout_seconds: 2,
  };
  return pinEffectAuthority(grant, [implementation]);
}

function options(origin: string, credentialPath: string) {
  return {
    authority: authority(origin),
    request: effectRequest,
    operationId: "operation-17",
    credentialFiles: { "delivery-token": credentialPath },
    persistPrepared: () => undefined,
    assertOpen: () => undefined,
  };
}

describe("remote controller effect", () => {
  it("persists the exact intent and fences immediately before one authenticated write", async () => {
    const credential = createCredential();
    let prepared = false;
    let requests = 0;
    await withService(
      (incoming, response) => {
        requests += 1;
        expect(prepared).toBe(true);
        expect(incoming.method).toBe("PUT");
        expect(incoming.url).toBe("/v1/delivery");
        expect(incoming.headers.authorization).toBe("Bearer test-secret");
        expect(incoming.headers["idempotency-key"]).toBe("delivery-17");
        response.end(JSON.stringify(effectResult));
      },
      async (origin) => {
        const result = await executeRemoteEffect({
          ...options(origin, credential),
          persistPrepared: async (record) => {
            expect(record).toMatchObject({
              operationId: "operation-17",
              remoteId: "fake-service",
              exactOrigin: origin,
              exactPath: "/v1/delivery",
              targetRef: "refs/heads/main",
              reviewedHead: sha("2"),
              expectedPrior: sha("3"),
              idempotencyKey: "delivery-17",
              credentialSourceId: "delivery-token",
            });
            await new Promise((resolve) => setTimeout(resolve, 5));
            prepared = true;
          },
          assertOpen: () => expect(prepared).toBe(true),
        });
        expect(result).toMatchObject({ kind: "applied", remoteObjectOid: sha("2") });
      },
    );
    expect(requests).toBe(1);
  });

  it("treats mismatched success, failure, and redirect as unknown without following it", async () => {
    const credential = createCredential();
    let requests = 0;
    await withService(
      (_incoming, response) => {
        requests += 1;
        if (requests === 1)
          response.end(JSON.stringify({ ...effectResult, reviewed_head: sha("6") }));
        else if (requests === 2) {
          response.statusCode = 500;
          response.end("internal detail must not escape");
        } else {
          response.statusCode = 302;
          response.setHeader("location", "/untrusted");
          response.end();
        }
      },
      async (origin) => {
        await expect(executeRemoteEffect(options(origin, credential))).resolves.toEqual({
          kind: "unknown",
          diagnosticCode: "result_verification_failed",
        });
        await expect(executeRemoteEffect(options(origin, credential))).resolves.toEqual({
          kind: "unknown",
          diagnosticCode: "unverified_response",
        });
        await expect(executeRemoteEffect(options(origin, credential))).resolves.toEqual({
          kind: "unknown",
          diagnosticCode: "redirect_rejected",
        });
      },
    );
    expect(requests).toBe(3);
  });

  it("accepts only a matching authoritative nonapplication response", async () => {
    const credential = createCredential();
    await withService(
      (_incoming, response) => {
        response.statusCode = 412;
        response.end(
          JSON.stringify({
            schema_version: 1,
            status: "not_applied",
            idempotency_key: "delivery-17",
            observed_oid: sha("7"),
          }),
        );
      },
      async (origin) => {
        await expect(executeRemoteEffect(options(origin, credential))).resolves.toEqual({
          kind: "not_applied",
          observedOid: sha("7"),
        });
      },
    );
  });

  it("marks a connection loss after send uncertain and never retries the write", async () => {
    const credential = createCredential();
    let requests = 0;
    await withService(
      (incoming) => {
        requests += 1;
        incoming.socket.destroy();
      },
      async (origin) => {
        await expect(executeRemoteEffect(options(origin, credential))).resolves.toEqual({
          kind: "unknown",
          diagnosticCode: "transport_ambiguous",
        });
      },
    );
    expect(requests).toBe(1);
  });

  it("reconciles by GET on the same pinned path and idempotency key without replay", async () => {
    const credential = createCredential();
    const methods: string[] = [];
    await withService(
      (incoming, response) => {
        methods.push(incoming.method ?? "");
        expect(incoming.url).toBe("/v1/delivery");
        expect(incoming.headers["idempotency-key"]).toBe("delivery-17");
        response.end(
          JSON.stringify({ schema_version: 1, status: "applied", result: effectResult }),
        );
      },
      async (origin) => {
        await expect(
          reconcileRemoteEffect({
            authority: authority(origin),
            request: effectRequest,
            operationId: "operation-17",
            credentialFiles: { "delivery-token": credential },
            assertOpen: () => undefined,
          }),
        ).resolves.toMatchObject({ kind: "applied", remoteObjectOid: sha("2") });
      },
    );
    expect(methods).toEqual(["GET"]);
  });

  it("persists before a closed canary and sends no request", async () => {
    const credential = createCredential();
    let prepared = false;
    let requests = 0;
    await withService(
      (_incoming, response) => {
        requests += 1;
        response.end();
      },
      async (origin) => {
        await expect(
          executeRemoteEffect({
            ...options(origin, credential),
            persistPrepared: () => {
              prepared = true;
            },
            assertOpen: () => {
              throw new Error("closed");
            },
          }),
        ).rejects.toThrow("closed");
      },
    );
    expect(prepared).toBe(true);
    expect(requests).toBe(0);
  });

  it("persists before an abort fence and sends no request", async () => {
    const credential = createCredential();
    const controller = new AbortController();
    controller.abort();
    let prepared = false;
    let requests = 0;
    await withService(
      (_incoming, response) => {
        requests += 1;
        response.end();
      },
      async (origin) => {
        await expect(
          executeRemoteEffect({
            ...options(origin, credential),
            persistPrepared: () => {
              prepared = true;
            },
            signal: controller.signal,
          }),
        ).rejects.toThrow();
      },
    );
    expect(prepared).toBe(true);
    expect(requests).toBe(0);
  });

  it("rejects an unprotected credential without disclosing its path or contents", () => {
    const credential = createCredential(0o644);
    let message = "";
    try {
      readProtectedCredentialFile("delivery-token", { "delivery-token": credential });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("remote effect credential file is not protected");
    expect(message).not.toContain(credential);
    expect(message).not.toContain("test-secret");
  });

  it("rejects a credential reached through a symlinked parent directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "remote-effect-parent-"));
    temporaryDirectories.push(directory);
    const actual = join(directory, "actual");
    const linked = join(directory, "linked");
    mkdirSync(actual, { mode: 0o700 });
    writeFileSync(join(actual, "credential"), "test-secret", { mode: 0o600 });
    symlinkSync(actual, linked);
    expect(() =>
      readProtectedCredentialFile("delivery-token", {
        "delivery-token": join(linked, "credential"),
      }),
    ).toThrow("credential file is not protected");
  });
});
