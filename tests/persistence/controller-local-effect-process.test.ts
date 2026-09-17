import { describe, expect, it } from "vitest";
import { parsePersistedRecord } from "../../src/host/log-file-parser.js";
import {
  assertLocalProgramProcessRecord,
  isLocalProgramProcessRecord,
} from "../../src/persistence/controller-local-effect-process.js";

const sha = (character: string) => character.repeat(64);

const admitted = {
  type: "controller_local_effect_process_admitted" as const,
  schema_version: 1 as const,
  run_id: "run",
  controller_id: "controller",
  definition_digest: sha("1"),
  activation_id: "activation",
  owner_epoch: 1,
  action_id: "action",
  adapter_id: "adapter",
  effect_id: "effect",
  operation_id: sha("2"),
  invocation_id: sha("3"),
  command: "execute" as const,
  implementation_id: "provider",
  implementation_digest: sha("4"),
  authority_digest: sha("5"),
  request_digest: sha("6"),
  subject: {
    repository_id: "repo",
    source_ref: "refs/pi-conductor/integration/reviewed",
    target_ref: "refs/heads/main",
    reviewed_head: sha("7"),
  },
  supervision_id: "supervision",
  admission: {
    schema_version: 1 as const,
    boot_id: "12345678-1234-1234-1234-123456789abc",
    pid_namespace: "pid:[1]",
    time_namespace: "time:[1]",
    network_namespace: "net:[1]",
    init_start_time: "1",
    preexisting_before: "2",
  },
  ts: 1,
};

describe("local effect process journal", () => {
  it("accepts a complete pre-spawn admission record", () => {
    expect(() => assertLocalProgramProcessRecord(admitted)).not.toThrow();
    expect(isLocalProgramProcessRecord(admitted)).toBe(true);
  });

  it("retains the known process record type when a JSONL log resumes", () => {
    expect(parsePersistedRecord(admitted, "run", 1)).toMatchObject({
      type: "controller_local_effect_process_admitted",
      invocation_id: admitted.invocation_id,
    });
  });

  it.each([
    ["missing admission", { ...admitted, admission: undefined }],
    ["arbitrary command", { ...admitted, command: "shell" }],
    ["missing durable operation", { ...admitted, operation_id: "operation" }],
  ])("rejects %s", (_name, record) => {
    expect(() => assertLocalProgramProcessRecord(record)).toThrow("process record is malformed");
  });
});
