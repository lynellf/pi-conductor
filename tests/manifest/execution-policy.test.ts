import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOOL_EXECUTION_POLICY,
  resolveToolExecutionPolicy,
} from "../../src/manifest/execution-policy.js";
import { parseManifest } from "../../src/manifest/parse.js";
import {
  DEFAULT_SUBAGENT_EXECUTION_POLICY,
  resolveSubagentExecutionPolicy,
} from "../../src/manifest/subagent-execution-policy.js";
import { type Manifest, ManifestParseError } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

const BASE_YAML = `
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 1
subagents:
  - name: helper
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/helper.md
`;

describe("tool_execution manifest policy", () => {
  it("keeps omitted blocks absent while resolving the frozen default", () => {
    const manifest = parseManifest(BASE_YAML);

    expect(manifest.roles[1]?.tool_execution).toBeUndefined();
    expect(manifest.subagents?.[0]?.tool_execution).toBeUndefined();
    expect(resolveToolExecutionPolicy()).toEqual(DEFAULT_TOOL_EXECUTION_POLICY);
    expect(Object.isFrozen(resolveToolExecutionPolicy())).toBe(true);
  });

  it("normalizes configured role and profile blocks independently", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tool_execution:
      timeout_seconds: 42
  - name: worker
    max_visits: 1
    tool_execution:
      max_recoverable_timeouts: 5
subagents:
  - name: helper
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/helper.md
    tool_execution:
      termination_grace_seconds: 9
`);

    expect(manifest.roles[0]?.tool_execution).toEqual({
      timeout_seconds: 42,
      max_recoverable_timeouts: 2,
      termination_grace_seconds: 2,
    });
    expect(manifest.roles[1]?.tool_execution).toEqual({
      timeout_seconds: 300,
      max_recoverable_timeouts: 5,
      termination_grace_seconds: 2,
    });
    expect(manifest.subagents?.[0]?.tool_execution).toEqual({
      timeout_seconds: 300,
      max_recoverable_timeouts: 2,
      termination_grace_seconds: 9,
    });
    expect(Object.isFrozen(manifest.roles[0]?.tool_execution)).toBe(true);
    expect(Object.isFrozen(manifest.subagents?.[0]?.tool_execution)).toBe(true);
  });

  it("accepts an empty configured block and the maximum timeout", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tool_execution: {}
  - name: worker
    max_visits: 1
    tool_execution:
      timeout_seconds: 3600
`);

    expect(manifest.roles[0]?.tool_execution).toEqual(DEFAULT_TOOL_EXECUTION_POLICY);
    expect(manifest.roles[1]?.tool_execution?.timeout_seconds).toBe(3600);
  });

  it.each([
    ["timeout_seconds", 0],
    ["timeout_seconds", -1],
    ["timeout_seconds", 1.5],
    ["timeout_seconds", 3601],
    ["timeout_seconds", Number.NaN],
    ["timeout_seconds", Number.POSITIVE_INFINITY],
    ["max_recoverable_timeouts", 0],
    ["max_recoverable_timeouts", -1],
    ["max_recoverable_timeouts", 1.5],
    ["max_recoverable_timeouts", Number.NaN],
    ["max_recoverable_timeouts", Number.POSITIVE_INFINITY],
    ["termination_grace_seconds", 0],
    ["termination_grace_seconds", -1],
    ["termination_grace_seconds", 1.5],
    ["termination_grace_seconds", Number.NaN],
    ["termination_grace_seconds", Number.POSITIVE_INFINITY],
  ])("rejects invalid %s=%s in YAML", (field, value) => {
    const yamlValue = Number.isNaN(value) ? ".nan" : String(value);
    const raw = `${BASE_YAML.replace(/subagents:[\s\S]*$/, "")}    tool_execution:\n      ${field}: ${yamlValue}\n`;
    expect(() => parseManifest(raw)).toThrow(ManifestParseError);
  });

  it.each(["null", "[]"])("rejects a %s tool_execution block", (block) => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tool_execution: ${block}
`),
    ).toThrow(ManifestParseError);
  });

  it("rejects unknown tool_execution fields", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tool_execution: { timeout_seconds: 10, extra: true }
  - name: worker
    max_visits: 1
`),
    ).toThrow("has unknown key 'extra'");
  });

  it("reports malformed programmatic role and profile policies", () => {
    const parsed = parseManifest(BASE_YAML);
    const helper = parsed.subagents?.[0];
    if (helper === undefined) throw new Error("fixture must contain helper profile");

    const manifest = {
      ...parsed,
      roles: [
        {
          name: "orchestrator" as const,
          is_orchestrator: true,
          tool_execution: { timeout_seconds: Number.POSITIVE_INFINITY },
        },
        {
          name: "worker" as const,
          max_visits: 1,
        },
      ],
      subagents: [
        {
          ...helper,
          tool_execution: { max_recoverable_timeouts: Number.NaN },
        },
      ],
    } as unknown as Manifest;

    const codes = validateManifest(manifest).errors.map((error) => error.code);
    expect(codes.filter((code) => code === "invalid-tool-execution-policy")).toHaveLength(2);
  });
});

describe("subagent execution manifest policy", () => {
  it("keeps omitted execution file-only with no runtime authority", () => {
    const manifest = parseManifest(BASE_YAML);
    const profile = manifest.subagents?.[0];
    if (profile === undefined) throw new Error("fixture must contain helper profile");

    expect(profile.execution).toBeUndefined();
    expect(resolveSubagentExecutionPolicy()).toEqual(DEFAULT_SUBAGENT_EXECUTION_POLICY);
    expect(Object.isFrozen(resolveSubagentExecutionPolicy())).toBe(true);
  });

  it("parses and resolves strict bubblewrap authority", () => {
    const manifest = parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 1
subagents:
  - name: helper
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/helper.md
    execution:
      backend: bubblewrap
      runtime_root: .pi/prepared-runtime
      writable_paths: [src, tests/unit.test.ts]
      network: none
      environment:
        PATH: /usr/bin:/bin
        LANG: C.UTF-8
      max_output_bytes: 1024
`);
    const execution = manifest.subagents?.[0]?.execution;
    expect(execution).toEqual({
      backend: "bubblewrap",
      runtime_root: ".pi/prepared-runtime",
      writable_paths: ["src", "tests/unit.test.ts"],
      network: "none",
      environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      max_output_bytes: 1024,
    });
    expect(resolveSubagentExecutionPolicy(execution)).toMatchObject({
      backend: "bubblewrap",
      runtime_root: ".pi/prepared-runtime",
      writable_paths: ["src", "tests/unit.test.ts"],
      max_output_bytes: 1024,
    });
    expect(Object.isFrozen(execution)).toBe(true);
  });

  it.each([
    ["backend: host", "backend"],
    ["runtime_root: /host/root", "runtime_root"],
    ["runtime_root: ../outside", "runtime_root"],
    ["writable_paths: [.git/config]", "writable_paths"],
    ["writable_paths: [src, src/lib]", "writable_paths"],
    ["network: bridge", "network"],
    ["environment: {HOME: /host}", "environment"],
    ["environment: {PATH: relative/bin}", "environment"],
    ["max_output_bytes: 0", "max_output_bytes"],
  ])("rejects unsafe execution setting %s", (setting) => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
  - name: worker
    max_visits: 1
subagents:
  - name: helper
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: .pi/subagents/helper.md
    execution:
      backend: bubblewrap
      runtime_root: .pi/prepared-runtime
      ${setting}
`),
    ).toThrow(ManifestParseError);
  });

  it("requires runtime_root for bubblewrap", () => {
    expect(() => resolveSubagentExecutionPolicy({ backend: "bubblewrap" })).toThrow(
      ManifestParseError,
    );
  });

  it("rejects an explicitly empty execution block", () => {
    expect(() => resolveSubagentExecutionPolicy({})).toThrow(ManifestParseError);
  });

  it("rejects sandbox authority that would otherwise silently use file-only", () => {
    expect(() => resolveSubagentExecutionPolicy({ writable_paths: ["src"] })).toThrow(
      ManifestParseError,
    );
  });
});
