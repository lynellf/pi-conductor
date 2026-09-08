import { describe, expect, it } from "vitest";

import {
  assertDelegationMode,
  DEFAULT_DELEGATION_MODE,
  resolveDelegationMode,
} from "../../src/manifest/delegation-mode.js";
import { parseManifest } from "../../src/manifest/parse.js";
import type { DelegationPolicy, Manifest } from "../../src/manifest/types.js";
import { validateManifest } from "../../src/manifest/validate.js";

const policy = (mode?: DelegationPolicy["mode"]): DelegationPolicy => ({
  ...(mode === undefined ? {} : { mode }),
  allowed_subagents: ["coder"],
  max_children_per_session: 2,
  max_parallel: 1,
});

describe("manifest delegation mode (Issue #86)", () => {
  it.each(["blocking", "nonblocking"] as const)("accepts %s", (mode) => {
    expect(resolveDelegationMode(policy(mode))).toBe(mode);
  });

  it("defaults omitted programmatic policy to blocking", () => {
    expect(resolveDelegationMode(policy())).toBe(DEFAULT_DELEGATION_MODE);
  });

  it("allows omitted or matching compatibility mode", () => {
    expect(() => assertDelegationMode("blocking", undefined)).not.toThrow();
    expect(() => assertDelegationMode("nonblocking", "nonblocking")).not.toThrow();
  });

  it("rejects conflicting compatibility mode before admission", () => {
    expect(() => assertDelegationMode("blocking", "nonblocking")).toThrow(
      "manifest configures blocking",
    );
  });

  it("normalizes omitted YAML mode to blocking", () => {
    const manifest = parseManifest(`
version: 1
subagents:
  - name: coder
    models: [stub:coder]
    max_session_cost_usd: 1
    system_prompt: prompt.md
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end, delegate]
    delegation:
      allowed_subagents: [coder]
      max_children_per_session: 2
      max_parallel: 1
`);
    expect(manifest.roles[0]?.delegation?.mode).toBe("blocking");
  });

  it("rejects invalid YAML mode", () => {
    expect(() =>
      parseManifest(`
version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    delegation:
      mode: sometimes
      allowed_subagents: [coder]
      max_children_per_session: 1
      max_parallel: 1
`),
    ).toThrow('delegation.mode must be "blocking" or "nonblocking"');
  });

  it("reports invalid programmatic mode", () => {
    const manifest = {
      version: 1,
      roles: [{ name: "orchestrator", is_orchestrator: true, delegation: policy("blocking") }],
    } as Manifest;
    (manifest.roles[0]?.delegation as { mode?: unknown }).mode = "sometimes";
    expect(validateManifest(manifest).errors.map((error) => error.code)).toContain(
      "invalid-delegation-mode",
    );
  });

  it("does not silently default a null programmatic mode", () => {
    expect(() => resolveDelegationMode({ ...policy(), mode: null as never })).toThrow(
      "delegation.mode must be",
    );
  });
});
