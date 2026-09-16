import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  controllerConfigSchema,
  parseControllerConfig,
  resolveControllerLimits,
} from "../../src/manifest/controller.js";
import {
  controllerDelegateActionSchema,
  controllerRequestSchema,
  controllerResponseSchema,
} from "../../src/manifest/controller-protocol.js";
import { parseManifest } from "../../src/manifest/parse.js";
import type { Manifest } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

describe("controller manifest and protocol contracts", () => {
  it("accepts a bounded controller definition and closed adapter declarations", () => {
    expect(
      Value.Check(controllerConfigSchema, {
        protocol_version: 1,
        delegation: {
          allowed_subagents: ["worker"],
          max_children_per_session: 3,
          max_parallel: 2,
        },
        controller_id: "repo-controller",
        runtime_id: "runtime-v1",
        executable: "/approved/controller",
        argv: ["--protocol", "v1"],
        adapters: [
          {
            id: "validate",
            runtime_id: "runtime-v1",
            executable: "/approved/validate",
            argv: [],
            input_schema_id: "validate-input-v1",
            output_schema_id: "validate-output-v1",
            capability: "read_only",
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects unknown controller and adapter properties", () => {
    const valid = {
      protocol_version: 1,
      controller_id: "repo-controller",
      runtime_id: "runtime-v1",
      executable: "/approved/controller",
      argv: [],
      adapters: [],
      delegation: { allowed_subagents: ["worker"], max_children_per_session: 1, max_parallel: 1 },
    };
    expect(Value.Check(controllerConfigSchema, { ...valid, extra: true })).toBe(false);
    expect(
      Value.Check(controllerConfigSchema, {
        ...valid,
        adapters: [
          {
            id: "a",
            runtime_id: "runtime-v1",
            executable: "/a\u0000",
            argv: [],
            input_schema_id: "in",
            output_schema_id: "out",
            capability: "read_only",
            extra: true,
          },
        ],
      }),
    ).toBe(false);
    expect(Value.Check(controllerConfigSchema, valid)).toBe(true);
  });

  it("resolves conservative per-run limits", () => {
    expect(resolveControllerLimits(undefined)).toMatchObject({
      planner_deadline_seconds: 30,
      max_outstanding_adapters: 1,
      max_decisions: 10000,
      max_actions: 10000,
      max_outstanding_actions: 64,
    });
  });

  it("freezes a controller configuration independently of its parsed source", () => {
    const source = {
      protocol_version: 1,
      controller_id: "repo-controller",
      runtime_id: "runtime-v1",
      executable: "/approved/controller",
      argv: [],
      adapters: [],
      delegation: { allowed_subagents: ["worker"], max_children_per_session: 1, max_parallel: 1 },
    };
    expect(Value.Check(controllerConfigSchema, source)).toBe(true);
    const config = parseControllerConfig(source);
    source.delegation.allowed_subagents.push("changed");
    expect(config.delegation.allowed_subagents).toEqual(["worker"]);
    expect(Object.isFrozen(config.delegation)).toBe(true);
    expect(Object.isFrozen(config.delegation.allowed_subagents)).toBe(true);
  });

  it("accepts each closed decision and action discriminant", () => {
    const base = {
      protocol_version: 1,
      run_id: "run",
      controller_id: "controller",
      owner_epoch: 1,
      definition_digest: "a".repeat(64),
      activation_id: "activation",
      state_revision: 2,
      event_cursor: null,
      capacity: { running: 0, queued: 0, remaining_allowance: 3, max_parallel: 2 },
      state: { phase: "idle" },
      events: [],
      page_cursor: null,
      pending_operations: [],
    };
    expect(
      Value.Check(controllerRequestSchema, {
        ...base,
        capacity: { running: 0, queued: 0, remaining_allowance: 3, max_parallel: 2 },
      }),
    ).toBe(true);
    delete (base as { capacity?: unknown }).capacity;
    delete (base as { run_id?: unknown }).run_id;
    delete (base as { controller_id?: unknown }).controller_id;
    delete (base as { owner_epoch?: unknown }).owner_epoch;
    delete (base as { events?: unknown }).events;
    delete (base as { page_cursor?: unknown }).page_cursor;
    delete (base as { pending_operations?: unknown }).pending_operations;
    const actions = [
      {
        kind: "delegate",
        action_id: "delegate-1",
        tasks: [{ id: "task-1", subagent: "worker", objective: "do", expected_output: "done" }],
      },
      { kind: "adapter", action_id: "adapter-1", adapter_id: "validate", input_refs: ["input"] },
      { kind: "read", action_id: "read-1", ref: "receipt" },
      { kind: "cancel", action_id: "cancel-1", child_ids: ["child-1"] },
    ] as const;
    for (const decision of ["plan", "wait", "finish", "escalate"] as const) {
      const decisions = decision === "plan" ? actions : [undefined];
      for (const action of decisions) {
        expect(
          Value.Check(controllerResponseSchema, {
            ...base,
            run_id: "run",
            controller_id: "controller",
            owner_epoch: 1,
            decision,
            ...(action === undefined ? {} : { actions: [action] }),
            ...(decision === "finish" ? { payload: { reason: "done" } } : {}),
            ...(decision === "escalate" ? { reason: "blocked", evidence_refs: ["evidence"] } : {}),
          }),
        ).toBe(true);
      }
    }
  });

  it("parses controller mode and rejects SDK orchestrator settings", () => {
    const manifest = parseManifest(`
version: 1
controller:
  protocol_version: 1
  controller_id: repo-controller
  runtime_id: runtime-v1
  executable: /approved/controller
  argv: []
  adapters: []
  delegation:
    allowed_subagents: [worker]
    max_children_per_session: 1
    max_parallel: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    models: [stub:model]
    delegation:
      allowed_subagents: [worker]
      max_children_per_session: 1
      max_parallel: 1
subagents:
  - name: worker
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: worker.md
`);
    expect(manifest.controller?.controller_id).toBe("repo-controller");
    expect(validateManifest(manifest).errors.map((error) => error.code)).toContain(
      "controller-orchestrator-model-unsupported",
    );
  });

  it("accepts controller delegation without SDK orchestrator settings", () => {
    const manifest = parseManifest(`
version: 1
controller:
  protocol_version: 1
  controller_id: repo-controller
  runtime_id: runtime-v1
  executable: /approved/controller
  argv: []
  adapters: []
  delegation:
    allowed_subagents: [worker]
    max_children_per_session: 1
    max_parallel: 1
roles:
  - name: orchestrator
    is_orchestrator: true
subagents:
  - name: worker
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: worker.md
`);
    expect(validateManifest(manifest).errors).toEqual([]);
  });

  it("rejects duplicate controller adapters and allowed profiles", () => {
    const manifest = parseManifest(`
version: 1
controller:
  protocol_version: 1
  controller_id: repo-controller
  runtime_id: runtime-v1
  executable: /approved/controller
  argv: []
  adapters:
    - id: validate
      runtime_id: runtime-v1
      executable: /approved/validate
      argv: []
      input_schema_id: validate-input-v1
      output_schema_id: validate-output-v1
      capability: read_only
    - id: validate
      runtime_id: runtime-v1
      executable: /approved/validate
      argv: []
      input_schema_id: validate-input-v1
      output_schema_id: validate-output-v1
      capability: read_only
  delegation:
    allowed_subagents: [worker, worker]
    max_children_per_session: 1
    max_parallel: 1
roles:
  - name: orchestrator
    is_orchestrator: true
subagents:
  - name: worker
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: worker.md
`);

    expect(validateManifest(manifest).errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "controller-duplicate-adapter-id",
        "delegation-duplicate-allowed-subagent",
      ]),
    );
  });

  it("rejects controller-incompatible end requests and SDK delegation", () => {
    const manifest = parseManifest(`
version: 1
end_request_roles: [worker]
controller:
  protocol_version: 1
  controller_id: repo-controller
  runtime_id: runtime-v1
  executable: /approved/controller
  argv: []
  adapters: []
  delegation:
    allowed_subagents: [worker]
    max_children_per_session: 1
    max_parallel: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    delegation:
      allowed_subagents: [worker]
      max_children_per_session: 1
      max_parallel: 1
subagents:
  - name: worker
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: worker.md
`);

    expect(validateManifest(manifest).errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "controller-end-request-roles-unsupported",
        "controller-orchestrator-delegation-unsupported",
      ]),
    );
  });

  it("reports malformed programmatic controller configuration without dereferencing it", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
`);
    const report = validateManifest({ ...manifest, controller: {} } as Manifest);

    expect(report.errors.map((error) => error.code)).toContain("invalid-controller-config");
  });

  it("accepts a nonempty event page and caps it at 128 events", () => {
    const request = {
      protocol_version: 1,
      run_id: "run",
      controller_id: "controller",
      owner_epoch: 1,
      definition_digest: "a".repeat(64),
      activation_id: "activation",
      state_revision: 0,
      event_cursor: null,
      state: {},
      events: [{ kind: "startup", source: null, payload: { started: true } }],
      page_cursor: null,
      pending_operations: [],
      capacity: { running: 0, queued: 0, remaining_allowance: 1, max_parallel: 1 },
    };

    expect(Value.Check(controllerRequestSchema, request)).toBe(true);
    expect(
      Value.Check(controllerRequestSchema, {
        ...request,
        events: Array.from({ length: 129 }, () => request.events[0]),
      }),
    ).toBe(false);
  });

  it("caps controller delegate batches at 64 native tasks", () => {
    const task = {
      id: "task",
      subagent: "worker",
      objective: "implement",
      expected_output: "patch",
    };
    expect(
      Value.Check(controllerDelegateActionSchema, {
        kind: "delegate",
        action_id: "delegate",
        tasks: Array.from({ length: 64 }, () => task),
      }),
    ).toBe(true);
    expect(
      Value.Check(controllerDelegateActionSchema, {
        kind: "delegate",
        action_id: "delegate",
        tasks: Array.from({ length: 65 }, () => task),
      }),
    ).toBe(false);
  });

  it("reports controller topology, profile, and capacity validation failures", () => {
    const manifest = parseManifest(`
version: 1
controller:
  protocol_version: 1
  controller_id: repo-controller
  runtime_id: runtime-v1
  executable: /approved/controller
  argv: []
  adapters: []
  delegation:
    allowed_subagents: [worker]
    max_children_per_session: 1
    max_parallel: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    delegation:
      allowed_subagents: [worker]
      max_children_per_session: 1
      max_parallel: 1
subagents:
  - name: worker
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: worker.md
`);
    const cases = [
      [
        "workers",
        { roles: [...manifest.roles, { name: "worker" }] },
        "controller-workers-unsupported",
      ],
      [
        "unknown profile",
        {
          controller: {
            ...manifest.controller,
            delegation: { ...manifest.controller?.delegation, allowed_subagents: ["missing"] },
          },
        },
        "delegation-undeclared-subagent",
      ],
      [
        "bad parallel",
        {
          controller: {
            ...manifest.controller,
            delegation: { ...manifest.controller?.delegation, max_parallel: 2 },
          },
        },
        "delegation-max-parallel-exceeds-slot-limit",
      ],
    ] as const;
    for (const [name, change, code] of cases) {
      expect(
        validateManifest({ ...manifest, ...change } as Manifest).errors.map((error) => error.code),
        name,
      ).toContain(code);
    }
  });
});
