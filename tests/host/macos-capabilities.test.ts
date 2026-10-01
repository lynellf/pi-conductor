import { afterEach, describe, expect, it, vi } from "vitest";
import * as native from "../../src/host/execution/macos/observer-runtime.js";
import { assertProductionExecutionCapabilities } from "../../src/host/execution/production-capabilities.js";
import { parseManifest } from "../../src/manifest/parse.js";

const base = `version: 1
roles:
  - name: orchestrator
    is_orchestrator: true
    tools: [handoff, end]
`;
const profile = `subagents:
  - name: builder
    models: [stub:model]
    max_session_cost_usd: 1
    system_prompt: builder.md
    execution: { backend: bubblewrap, runtime_root: runtime, writable_paths: [src] }
`;

afterEach(() => vi.restoreAllMocks());

describe.runIf(process.platform === "darwin")("Darwin production capability preflight", () => {
  it("prepares the native backend for a later worker even when the orchestrator is tool-free", () => {
    const prepare = vi.spyOn(native, "assertMacObserverReady").mockReturnValue(undefined);
    assertProductionExecutionCapabilities(
      parseManifest(`${base}  - name: worker\n    tools: [read]\n`),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it("prepares a guard-only workflow before command effects", () => {
    const prepare = vi.spyOn(native, "assertMacObserverReady").mockReturnValue(undefined);
    assertProductionExecutionCapabilities(
      parseManifest(`${base}end_guard: { command: /usr/bin/true }\n`),
    );
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it("does not require native tooling for a pure handoff/end workflow or unused sandbox profile", () => {
    const prepare = vi.spyOn(native, "assertMacObserverReady");
    assertProductionExecutionCapabilities(parseManifest(base + profile));
    expect(prepare).not.toHaveBeenCalled();
  });
  it("rejects referenced Bubblewrap without preparing an unsandboxed fallback", () => {
    const prepare = vi.spyOn(native, "assertMacObserverReady");
    const manifest = parseManifest(
      `${base}    delegation: { allowed_subagents: [builder], max_children_per_session: 1, max_parallel: 1 }\n${profile}`,
    );
    expect(() => assertProductionExecutionCapabilities(manifest)).toThrow(
      "subagent 'builder' requires Linux/Bubblewrap",
    );
    expect(prepare).not.toHaveBeenCalled();
  });
  it("rejects controller sandbox mode before native preparation", () => {
    const prepare = vi.spyOn(native, "assertMacObserverReady");
    const manifest = parseManifest(`${base}controller:
  protocol_version: 1
  controller_id: controller
  runtime_id: runtime
  executable: /approved/controller
  argv: []
  adapters: []
  delegation: { allowed_subagents: [builder], max_children_per_session: 1, max_parallel: 1 }
${profile}`);
    expect(() => assertProductionExecutionCapabilities(manifest)).toThrow(
      "controller sandbox execution requires Linux/Bubblewrap",
    );
    expect(prepare).not.toHaveBeenCalled();
  });
});
