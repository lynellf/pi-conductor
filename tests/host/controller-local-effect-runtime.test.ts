import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { effectAuthorityDigest } from "../../src/host/controller/effect-registry.js";
import { measureGitEffectRepository } from "../../src/host/controller/git-effect.js";
import { measureLocalProgramImplementation } from "../../src/host/controller/local-effect-measurement.js";
import {
  type LocalProgramEffectGrant,
  localProgramImplementationDigest,
  localProgramRuntimeDigest,
} from "../../src/host/controller/local-effect-registry.js";
import {
  captureLocalProgramProcessAdmission,
  inspectLocalProgramProcessAdmission,
  runTrustedLocalEffectProgram,
} from "../../src/host/controller/local-effect-runtime.js";
import type { LocalProgramInvocationInput } from "../../src/host/controller/local-effect-runtime-contract.js";
import { readProcessIdentity } from "../../src/host/execution/supervised-process-identity.js";
import {
  effectRequestSchemaDigest,
  effectResultSchemaDigest,
} from "../../src/manifest/controller-effect.js";
import { sha256Canonical } from "../../src/persistence/trajectory-records.js";

const execute = promisify(execFile);
const roots: string[] = [];
const hostDriverDigest = "d".repeat(64);

afterEach(async () => {
  delete process.env.LOCAL_EFFECT_AMBIENT_CANARY;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("trusted local effect runtime", () => {
  it("runs a fixed observe program with scrubbed authority and returns pending as applied", async () => {
    const fixture = await createFixture("pending");
    process.env.LOCAL_EFFECT_AMBIENT_CANARY = "must-not-leak";
    const settlements: unknown[] = [];

    const result = await runTrustedLocalEffectProgram({
      grant: fixture.grant,
      invocation: fixture.invocation,
      hostDriverDigest,
      processAdmission: await captureLocalProgramProcessAdmission(),
      workspaceRoot: fixture.workspace,
      credentialFiles: { forge_token: fixture.credential },
      assertInvocationOpen: () => undefined,
      onSpawn: () => undefined,
      onSettled: (settlement) => {
        settlements.push(settlement);
      },
    });

    expect(result).toMatchObject({
      kind: "outcome",
      outcome: {
        status: "applied",
        result: {
          payload: {
            stage: "pending",
            ambient: null,
            private_cwd: true,
            credential_seen: true,
          },
        },
      },
    });
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ cleanup: "confirmed", outcome: "completed" });
  });

  it("maps malformed output and credential echo to uncertainty", async () => {
    for (const mode of ["malformed", "echo-secret"] as const) {
      const fixture = await createFixture(mode);
      const result = await runTrustedLocalEffectProgram({
        grant: fixture.grant,
        invocation: fixture.invocation,
        hostDriverDigest,
        processAdmission: await captureLocalProgramProcessAdmission(),
        workspaceRoot: fixture.workspace,
        credentialFiles: { forge_token: fixture.credential },
        assertInvocationOpen: () => undefined,
        onSpawn: () => undefined,
        onSettled: () => undefined,
      });
      expect(result).toEqual({
        kind: "uncertain",
        diagnosticCode:
          mode === "malformed" ? "local-effect-malformed-output" : "local-effect-credential-echo",
      });
    }
  });

  it("maps a timeout and oversized response to uncertainty without replay", async () => {
    for (const [mode, diagnosticCode] of [
      ["timeout", "local-effect-timeout"],
      ["oversize", "local-effect-output-too-large"],
    ] as const) {
      const fixture = await createFixture(mode);
      const result = await runTrustedLocalEffectProgram({
        grant: fixture.grant,
        invocation: fixture.invocation,
        hostDriverDigest,
        processAdmission: await captureLocalProgramProcessAdmission(),
        workspaceRoot: fixture.workspace,
        credentialFiles: { forge_token: fixture.credential },
        assertInvocationOpen: () => undefined,
        onSpawn: () => undefined,
        onSettled: () => undefined,
      });
      expect(result).toEqual({ kind: "uncertain", diagnosticCode });
    }
  });

  it("withholds protocol input when the immediate authority recheck fails", async () => {
    const fixture = await createFixture("write-marker");
    let checks = 0;
    await expect(
      runTrustedLocalEffectProgram({
        grant: fixture.grant,
        invocation: fixture.invocation,
        hostDriverDigest,
        processAdmission: await captureLocalProgramProcessAdmission(),
        workspaceRoot: fixture.workspace,
        credentialFiles: { forge_token: fixture.credential },
        assertInvocationOpen: () => {
          checks += 1;
          if (checks > 1) throw new Error("revoked");
        },
        onSpawn: () => undefined,
        onSettled: () => undefined,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(checks).toBe(2);
    await expect(readFile(fixture.marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a changed program dependency before spawning", async () => {
    const fixture = await createFixture("pending");
    await writeFile(fixture.program, `${await readFile(fixture.program, "utf8")}\n// changed\n`, {
      mode: 0o700,
    });

    await expect(
      measureLocalProgramImplementation(fixture.grant, hostDriverDigest),
    ).rejects.toThrow("changed or was replaced");
  });

  it("does not retry an ambiguous settlement append", async () => {
    const fixture = await createFixture("pending");
    const persistenceFailure = new Error("append ambiguous");
    let attempts = 0;

    await expect(
      runTrustedLocalEffectProgram({
        grant: fixture.grant,
        invocation: fixture.invocation,
        hostDriverDigest,
        processAdmission: await captureLocalProgramProcessAdmission(),
        workspaceRoot: fixture.workspace,
        credentialFiles: { forge_token: fixture.credential },
        assertInvocationOpen: () => undefined,
        onSpawn: () => undefined,
        onSettled: () => {
          attempts += 1;
          throw persistenceFailure;
        },
      }),
    ).rejects.toBe(persistenceFailure);
    expect(attempts).toBe(1);
  });

  it("keeps settlement unconfirmed while an unmarked same-session child remains", async () => {
    const fixture = await createFixture("escaped-child");
    const settlements: { readonly cleanup: string; readonly outcome: string }[] = [];
    let childPid: number | undefined;
    try {
      const result = await runTrustedLocalEffectProgram({
        grant: fixture.grant,
        invocation: fixture.invocation,
        hostDriverDigest,
        processAdmission: await captureLocalProgramProcessAdmission(),
        workspaceRoot: fixture.workspace,
        credentialFiles: { forge_token: fixture.credential },
        assertInvocationOpen: () => undefined,
        onSpawn: () => undefined,
        onSettled: (settlement) => {
          settlements.push(settlement);
        },
      });
      childPid = Number(await readFile(fixture.marker, "utf8"));

      expect(result).toEqual({
        kind: "uncertain",
        diagnosticCode: "local-effect-process-cleanup-unconfirmed",
      });
      expect(settlements).toEqual([
        expect.objectContaining({ cleanup: "unconfirmed", outcome: "completed" }),
      ]);
      expect(await readProcessIdentity(childPid)).not.toBeNull();
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The child already exited.
        }
      }
    }
  });

  it("does not trust timeout cleanup while an unmarked same-session child remains", async () => {
    const fixture = await createFixture("escaped-timeout");
    const settlements: { readonly cleanup: string; readonly outcome: string }[] = [];
    let childPid: number | undefined;
    try {
      const result = await runTrustedLocalEffectProgram({
        grant: fixture.grant,
        invocation: fixture.invocation,
        hostDriverDigest,
        processAdmission: await captureLocalProgramProcessAdmission(),
        workspaceRoot: fixture.workspace,
        credentialFiles: { forge_token: fixture.credential },
        assertInvocationOpen: () => undefined,
        onSpawn: () => undefined,
        onSettled: (settlement) => {
          settlements.push(settlement);
        },
      });
      childPid = Number(await readFile(fixture.marker, "utf8"));

      expect(result).toEqual({ kind: "uncertain", diagnosticCode: "local-effect-timeout" });
      expect(settlements).toEqual([
        expect.objectContaining({ cleanup: "unconfirmed", outcome: "timed_out" }),
      ]);
      expect(await readProcessIdentity(childPid)).not.toBeNull();
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The child already exited.
        }
      }
    }
  });

  it("finds a same-session descendant even after it clears the owner marker", async () => {
    const admission = await captureLocalProgramProcessAdmission();
    const leader = spawn(
      process.execPath,
      [
        "-e",
        "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{},stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000)",
      ],
      {
        detached: true,
        env: { PI_CONDUCTOR_EXECUTION_ID: admission.supervisionId },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const childPid = await new Promise<number>((resolve, reject) => {
      leader.once("error", reject);
      leader.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    const identity = await readProcessIdentity(leader.pid ?? -1, admission.supervisionId);
    if (identity === null) throw new Error("test leader identity is unavailable");
    try {
      process.kill(identity.pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const observation = await inspectLocalProgramProcessAdmission({
        ...admission,
        spawnedIdentity: identity,
      });
      expect(observation.state).toBe("live");
      expect(observation.processes.map((process) => process.pid)).toContain(childPid);
    } finally {
      try {
        process.kill(-identity.processGroupId, "SIGKILL");
      } catch {
        // The test process group is already gone.
      }
    }
  });
});

async function createFixture(
  mode:
    | "pending"
    | "malformed"
    | "echo-secret"
    | "write-marker"
    | "timeout"
    | "oversize"
    | "escaped-child"
    | "escaped-timeout",
) {
  const root = await mkdtemp(join(tmpdir(), "pi-conductor-local-effect-"));
  roots.push(root);
  await chmod(root, 0o700);
  const repository = join(root, "repository");
  const workspace = join(root, "workspace");
  const program = join(root, "provider.mjs");
  const marker = join(root, "effect-marker");
  const credential = join(root, "credential");
  await execute("git", ["init", "--quiet", repository]);
  await writeFile(join(repository, "file.txt"), "reviewed\n");
  await execute("git", ["-C", repository, "add", "file.txt"]);
  await execute("git", [
    "-C",
    repository,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@invalid",
    "commit",
    "--quiet",
    "-m",
    "reviewed",
  ]);
  await execute("git", ["-C", repository, "branch", "-M", "source"]);
  await execute("git", ["-C", repository, "update-ref", "refs/heads/target", "HEAD"]);
  const reviewedHead = (
    await execute("git", ["-C", repository, "rev-parse", "HEAD"])
  ).stdout.trim();
  await writeFile(program, providerSource(), { mode: 0o700 });
  await writeFile(credential, "private-token", { mode: 0o600 });
  await (await import("node:fs/promises")).mkdir(workspace, { mode: 0o700 });
  const canonicalNode = await realpath(process.execPath);
  const repositoryIdentity = await measureGitEffectRepository(repository);
  const runtime = {
    id: "fixture-runtime",
    digest: "",
    dependencies: [{ canonical_path: program, sha256: await sha256(program) }],
  };
  runtime.digest = localProgramRuntimeDigest(runtime);
  const provider = {
    executable: { canonical_path: canonicalNode, sha256: await sha256(canonicalNode) },
    argv: [program, mode, marker],
    runtime,
    credential_source_ids: ["forge_token"],
    network: { allowed_origins: ["https://forge.invalid"] },
  };
  const inputDocument: Record<string, unknown> = {
    type: "object",
    properties: { action: { const: "observe", type: "string" } },
    required: ["action"],
    additionalProperties: false,
  };
  const resultDocument: Record<string, unknown> = {
    type: "object",
    properties: {
      stage: { const: "pending", type: "string" },
      ambient: { type: "null" },
      private_cwd: { type: "boolean" },
      credential_seen: { type: "boolean" },
    },
    required: ["stage", "ambient", "private_cwd", "credential_seen"],
    additionalProperties: false,
  };
  const implementationDigest = localProgramImplementationDigest(provider, hostDriverDigest);
  const grant: LocalProgramEffectGrant = {
    schema_version: 1,
    id: `fixture-${mode}`,
    adapter_id: "adapter",
    kind: "local_program",
    implementation_id: `fixture-${mode}-v1`,
    implementation_digest: implementationDigest,
    host_driver_digest: hostDriverDigest,
    request_schema_id: "local-program-request-v1",
    request_schema_digest: effectRequestSchemaDigest("local_program"),
    output_schema_id: "local-program-result-v1",
    output_schema_digest: effectResultSchemaDigest("local_program"),
    repository: {
      id: "repository",
      canonical_path: repositoryIdentity.canonical_path,
      fingerprint: repositoryIdentity.fingerprint,
    },
    provider,
    operations: [
      {
        operation: "observe_ci",
        semantics: "observe",
        input_schema: {
          id: "observe-input",
          digest: sha256Canonical(inputDocument),
          document: inputDocument,
        },
        result_schema: {
          id: "observe-result",
          digest: sha256Canonical(resultDocument),
          document: resultDocument,
        },
        resource_conflict_keys: ["pr:1"],
      },
    ],
    allowed_source_refs: ["refs/heads/source"],
    allowed_target_refs: ["refs/heads/target"],
    required_evidence: [{ producer_id: "reviewer", schema_id: "review-v1" }],
    max_input_bytes: 1_048_576,
    max_output_bytes: mode === "oversize" ? 100 : 65_536,
    timeout_seconds: mode === "timeout" || mode === "escaped-timeout" ? 1 : 2,
  };
  const evidenceSha = createHash("sha256").update("approved evidence").digest("hex");
  const request: LocalProgramInvocationInput["request"] = {
    schema_version: 1,
    kind: "local_program",
    repository_id: "repository",
    operation: "observe_ci",
    source_ref: "refs/heads/source",
    target_ref: "refs/heads/target",
    reviewed_head: reviewedHead,
    evidence: [
      {
        artifact_ref: "artifact:review",
        sha256: evidenceSha,
        producer_id: "reviewer",
        schema_id: "review-v1",
        subject_head: reviewedHead,
        verdict: "approved",
      },
    ],
    payload: { action: "observe" },
  };
  const requestDigest = sha256Canonical(request);
  const invocation: LocalProgramInvocationInput = {
    protocol_version: 1,
    command: mode === "write-marker" ? "execute" : "inspect",
    operation_id: "1".repeat(64),
    invocation_id: "2".repeat(64),
    implementation_id: grant.implementation_id,
    implementation_digest: grant.implementation_digest,
    authority_digest: effectAuthorityDigest(grant),
    request_digest: requestDigest,
    request,
    evidence: [
      {
        artifact_ref: "artifact:review",
        sha256: evidenceSha,
        bytes_base64: Buffer.from("approved evidence").toString("base64"),
      },
    ],
  };
  return { root, repository, workspace, program, marker, credential, grant, invocation };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function providerSource(): string {
  return `
import { spawn } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const invocation = JSON.parse(input);
  const mode = process.argv[2];
  if (mode === "malformed") return process.stdout.write("not-json");
  if (mode === "echo-secret") return process.stdout.write(invocation.credentials[0].value);
  if (mode === "oversize") return process.stdout.write("x".repeat(1000));
  if (mode === "timeout") return setInterval(() => {}, 1000);
  if (mode === "write-marker") writeFileSync(process.argv[3], "effect");
  const result = {
    schema_version: 1,
    kind: "local_program",
    repository_id: invocation.request.repository_id,
    operation: invocation.request.operation,
    source_ref: invocation.request.source_ref,
    target_ref: invocation.request.target_ref,
    reviewed_head: invocation.request.reviewed_head,
    payload: {
      stage: "pending",
      ambient: process.env.LOCAL_EFFECT_AMBIENT_CANARY ?? null,
      private_cwd: (statSync(process.cwd()).mode & 0o77) === 0,
      credential_seen: invocation.credentials[0].value === "private-token",
    },
  };
  const response = JSON.stringify({
    protocol_version: 1,
    operation_id: invocation.operation_id,
    invocation_id: invocation.invocation_id,
    implementation_id: invocation.implementation_id,
    implementation_digest: invocation.implementation_digest,
    authority_digest: invocation.authority_digest,
    request_digest: invocation.request_digest,
    status: "applied",
    result,
  });
  if (mode === "escaped-child" || mode === "escaped-timeout") {
    const child = spawn(
      "/usr/bin/python3",
      ["-c", "import os,time; os.setpgid(0,0); print('ready',flush=True); time.sleep(30)"],
      { env: {}, stdio: ["ignore", "pipe", "ignore"] },
    );
    child.stdout.once("data", () => {
      writeFileSync(process.argv[3], String(child.pid));
      child.stdout.destroy();
      child.unref();
      if (mode === "escaped-timeout") setInterval(() => {}, 1000);
      else process.stdout.write(response);
    });
    return;
  }
  process.stdout.write(response);
});
`;
}
