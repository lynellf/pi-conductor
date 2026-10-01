import { describe, expect, it } from "vitest";
import {
  detectExecutionCapabilities,
  preflightExecution,
} from "../../src/host/execution/execution-capabilities.js";
import { parseManifest } from "../../src/manifest/parse.js";

const ordinary = parseManifest(
  "version: 1\nroles:\n  - name: orchestrator\n    is_orchestrator: true\n    tools: [bash, read]\n",
);

const firstRole = ordinary.roles[0];
if (firstRole === undefined) throw new Error("missing fixture role");

describe("execution capability selection", () => {
  it.each(["darwin", "win32", "freebsd"] as const)("selects visible baseline on %s", (platform) => {
    const capabilities = detectExecutionCapabilities(platform);
    expect(preflightExecution(ordinary, capabilities).execution_tier).toBe("baseline");
    expect(capabilities.degradations).toContain("descendant-cleanup-unavailable");
  });
  it("detects unusable Linux observation instead of trusting the OS name", () => {
    expect(detectExecutionCapabilities("linux", () => false).execution_tier).toBe("baseline");
    expect(detectExecutionCapabilities("linux", () => true).execution_tier).toBe("enhanced");
  });
  it("rejects strict executable requirements before role admission", () => {
    const manifest = { ...ordinary, execution_policy: { mode: "strict" as const } };
    expect(() => preflightExecution(manifest, detectExecutionCapabilities("darwin"))).toThrow(
      "strict",
    );
  });
  it("allows strict handoff-only workflows without native execution", () => {
    const manifest = {
      ...ordinary,
      execution_policy: { mode: "strict" as const },
      roles: [{ ...firstRole, tools: ["handoff", "end"] }],
    };
    expect(
      preflightExecution(manifest, detectExecutionCapabilities("darwin")).degradations,
    ).toEqual([]);
  });
  it.each([
    "controller",
    "delegation",
    "bubblewrap",
  ])("rejects required %s without an unsandboxed fallback", (feature) => {
    const manifest =
      feature === "controller"
        ? { ...ordinary, controller: {} }
        : feature === "delegation"
          ? { ...ordinary, roles: [{ ...firstRole, delegation: {} }] }
          : {
              ...ordinary,
              roles: [{ ...firstRole, delegation: {} }],
              subagents: [{ name: "worker", execution: { backend: "bubblewrap" } }],
            };
    expect(() =>
      preflightExecution(manifest as typeof ordinary, detectExecutionCapabilities("darwin")),
    ).toThrow("requires");
  });
  it("rejects the staged Bubblewrap backend even on enhanced Linux", () => {
    const manifest = {
      ...ordinary,
      roles: [{ ...firstRole, delegation: {} }],
      subagents: [{ name: "worker", execution: { backend: "bubblewrap" } }],
    };
    // Partial configuration isolates capability presence; parser tests own semantic admission.
    expect(() =>
      preflightExecution(
        manifest as unknown as typeof ordinary,
        detectExecutionCapabilities("linux", () => true),
      ),
    ).toThrow("not enabled");
  });
  it("ignores unused profiles in a handoff-only manifest", () => {
    const manifest = {
      ...ordinary,
      roles: [{ ...firstRole, tools: ["handoff", "end"] }],
      subagents: [{ name: "worker", execution: { backend: "bubblewrap" } }],
    };
    expect(
      preflightExecution(
        manifest as unknown as typeof ordinary,
        detectExecutionCapabilities("darwin"),
      ).degradations,
    ).toEqual([]);
  });
  it.each([
    null,
    {},
    { mode: "anything" },
    { mode: "strict", typo: true },
  ])("rejects invalid execution policy %j", (execution_policy) => {
    expect(() =>
      parseManifest(
        `version: 1\nexecution_policy: ${JSON.stringify(execution_policy)}\nroles: []\n`,
      ),
    ).toThrow("execution_policy");
  });
  it("pins the parsed closed strict policy", () => {
    const parsed = parseManifest("version: 1\nexecution_policy: {mode: strict}\nroles: []\n");
    expect(parsed.execution_policy).toEqual({ mode: "strict" });
    expect(Object.isFrozen(parsed.execution_policy)).toBe(true);
  });
});
