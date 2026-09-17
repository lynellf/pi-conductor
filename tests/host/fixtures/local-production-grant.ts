import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  EffectGrant,
  SupportedEffectImplementation,
} from "../../../src/host/controller/effect-registry.js";
import { deriveLocalProgramHostDriverDigest } from "../../../src/host/controller/local-effect-measurement.js";
import {
  type LocalProgramEffectGrant,
  localProgramImplementationDigest,
  localProgramRuntimeDigest,
} from "../../../src/host/controller/local-effect-registry.js";
import {
  effectRequestSchemaDigest,
  effectResultSchemaDigest,
} from "../../../src/manifest/controller-effect.js";
import { sha256Canonical } from "../../../src/persistence/trajectory-records.js";

export async function createLocalProductionGrant(
  root: string,
  base: EffectGrant,
  supported: readonly SupportedEffectImplementation[],
): Promise<LocalProgramEffectGrant> {
  const program = join(root, "provider.mjs");
  await writeFile(
    program,
    `let text = ''; for await (const chunk of process.stdin) text += chunk;
const value = JSON.parse(text); const {request, ...envelope} = value;
const {evidence, scope, credentials, command, ...identity} = envelope;
const {evidence: ignored, ...result} = request;
process.stdout.write(JSON.stringify({...identity, status: 'applied', result: {...result, payload: {ci: 'pending'}}}));
`,
    { mode: 0o700 },
  );
  const executable = await realpath(process.execPath);
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const runtime = {
    id: "local-runtime",
    digest: "",
    dependencies: [{ canonical_path: program, sha256: await hash(program) }],
  };
  runtime.digest = localProgramRuntimeDigest(runtime);
  const provider = {
    executable: { canonical_path: executable, sha256: await hash(executable) },
    argv: [program],
    runtime,
    credential_source_ids: [],
    network: { allowed_origins: [] },
  };
  const hostDriverDigest = deriveLocalProgramHostDriverDigest(supported);
  const input = { type: "object", additionalProperties: false };
  const output = {
    type: "object",
    properties: { ci: { const: "pending", type: "string" } },
    required: ["ci"],
    additionalProperties: false,
  };
  return {
    schema_version: 1,
    id: base.id,
    adapter_id: base.adapter_id,
    kind: "local_program",
    implementation_id: "local-observe-v1",
    implementation_digest: localProgramImplementationDigest(provider, hostDriverDigest),
    host_driver_digest: hostDriverDigest,
    request_schema_id: "local-program-request-v1",
    request_schema_digest: effectRequestSchemaDigest("local_program"),
    output_schema_id: "local-program-result-v1",
    output_schema_digest: effectResultSchemaDigest("local_program"),
    repository: base.repository,
    provider,
    operations: [
      {
        operation: "observe",
        semantics: "observe",
        input_schema: { id: "observe-input", digest: sha256Canonical(input), document: input },
        result_schema: { id: "observe-result", digest: sha256Canonical(output), document: output },
        resource_conflict_keys: ["ci"],
      },
    ],
    allowed_source_refs: ["refs/reviewed/main"],
    allowed_target_refs: ["refs/releases/approved"],
    required_evidence: [{ producer_id: "validator", schema_id: "validation-v1" }],
    max_input_bytes: 65536,
    max_output_bytes: 65536,
    timeout_seconds: 10,
  };
}
