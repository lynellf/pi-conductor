import { describe, expect, it } from "vitest";
import { reconstructLocalProgramProcessTimeline } from "../../src/persistence/controller-local-effect-process-timeline.js";

const sha = (character: string) => character.repeat(64);
const admitted = {
  type: "controller_local_effect_process_admitted" as const,
  schema_version: 1 as const,
  run_id: "run",
  controller_id: "controller",
  definition_digest: sha("1"),
  activation_id: "old",
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

describe("local effect process recovery", () => {
  it("permits only a current-owner unconfirmed-to-confirmed cleanup follow-up", () => {
    const { admission: _admission, ...shared } = admitted;
    const unconfirmed = {
      ...shared,
      type: "controller_local_effect_process_settled" as const,
      activation_id: "old",
      outcome: "timed_out" as const,
      cleanup: "unconfirmed" as const,
      ts: 2,
    };
    const confirmed = {
      ...unconfirmed,
      activation_id: "new",
      owner_epoch: 2,
      outcome: "failed" as const,
      cleanup: "confirmed" as const,
      ts: 3,
    };
    expect(
      reconstructLocalProgramProcessTimeline([admitted, unconfirmed, confirmed]).unresolved,
    ).toHaveLength(0);
  });

  it("rejects a second confirmed settlement", () => {
    const { admission: _admission, ...shared } = admitted;
    const settled = {
      ...shared,
      type: "controller_local_effect_process_settled" as const,
      outcome: "completed" as const,
      cleanup: "confirmed" as const,
      ts: 2,
    };
    expect(() =>
      reconstructLocalProgramProcessTimeline([admitted, settled, { ...settled, ts: 3 }]),
    ).toThrow("not a monotonic");
  });
});
