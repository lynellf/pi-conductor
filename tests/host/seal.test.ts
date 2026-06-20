/**
 * Task 15.5 post-emission sealing tests — spec §12.1.
 *
 * Covers Task 15.5's acceptance criteria:
 *   1. A stub model that calls `handoff` (valid) and then `bash`
 *      produces ZERO `bash` side effects (asserted via a temp-file
 *      probe the `bash` call would have written), exactly one
 *      valid capture, and a normal `transition_accepted`.
 *   2. A stub model that calls `bash` then `handoff` runs `bash`
 *      normally (flag not yet set) and then seals.
 *   3. Multiple calls after sealing all short-circuit.
 *
 * The wrapper itself is unit-tested in isolation; the integration
 * tests verify the wrapper's interaction with Task 14's seam
 * (sealed flag flips on first valid capture).
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import {
  createHandoffTool,
  SessionSeam,
  wrapAllToolsWithSeal,
  wrapToolWithSeal,
} from "../../src/host/index.js";
import type { EmissionCapture } from "../../src/seam/validate-emission.js";

// ─── Test helpers ──────────────────────────────────────────────────────

/**
 * Invoke a tool's execute without an ExtensionContext. The SDK's
 * `ToolDefinition.execute` requires 5 args (the 5th is `ctx`, which
 * our wrapper ignores). Casting to a 2-arg call site is the test-
 * only shortcut.
 */
type ExecuteFn = (this: void, toolCallId: string, params: unknown) => Promise<unknown>;
function invoke(tool: ToolDefinition, params: unknown) {
  const execute = tool.execute as unknown as ExecuteFn;
  return execute.call(undefined, "test-call-id", params);
}

/** Build a fake `bash` tool that writes to a probe file as its side effect. */
function makeBash(probeFile: string, callCount: { n: number }) {
  return defineTool({
    name: "bash",
    label: "Bash",
    description: "Fake bash tool used by Task 15.5 tests (writes a probe file).",
    parameters: Type.Object({ cmd: Type.String() }),
    execute: async () => {
      callCount.n += 1;
      await writeFile(probeFile, "bash ran", "utf8");
      return { content: [{ type: "text" as const, text: "wrote" }], details: {} };
    },
  });
}

// ─── Unit tests: wrapToolWithSeal ──────────────────────────────────────

describe("wrapToolWithSeal — unit", () => {
  it("delegates to the underlying execute when sealCheck returns false", async () => {
    const callCount = { n: 0 };
    const bash = makeBash("/tmp/unused", callCount);
    const wrapped = wrapToolWithSeal(bash, () => false);

    const result = await invoke(wrapped, { cmd: "ls" });
    expect(callCount.n).toBe(1);
    expect((result as { content: { text: string }[] }).content[0]?.text).toBe("wrote");
  });

  it("short-circuits to error result when sealCheck returns true, execute NOT invoked", async () => {
    const callCount = { n: 0 };
    const bash = makeBash("/tmp/unused", callCount);
    const wrapped = wrapToolWithSeal(bash, () => true);

    const result = await invoke(wrapped, { cmd: "touch /tmp/foo" });
    expect(callCount.n).toBe(0);
    const r = result as { content: { text: string }[]; terminate?: boolean; details: unknown };
    expect(r.content[0]?.text).toContain("session sealed");
    expect(r.terminate).toBe(true);
    expect(r.details).toEqual({ sealed: true });
  });

  it("re-checks sealCheck on each call (live flag, not captured at wrap time)", async () => {
    const callCount = { n: 0 };
    const tool = defineTool({
      name: "test",
      label: "Test",
      description: "Test",
      parameters: Type.Object({}),
      execute: async () => {
        callCount.n += 1;
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    });

    let sealed = false;
    const wrapped = wrapToolWithSeal(tool, () => sealed);

    await invoke(wrapped, {});
    expect(callCount.n).toBe(1);

    sealed = true;
    await invoke(wrapped, {});
    expect(callCount.n).toBe(1);

    sealed = false;
    await invoke(wrapped, {});
    expect(callCount.n).toBe(2);

    sealed = true;
    await invoke(wrapped, {});
    expect(callCount.n).toBe(2);
  });

  it("preserves the original tool's metadata (name, label, description, parameters)", () => {
    const bash = defineTool({
      name: "bash",
      label: "Bash",
      description: "Test",
      parameters: Type.Object({ cmd: Type.String() }),
      execute: async () => ({ content: [], details: {} }),
    });
    const wrapped = wrapToolWithSeal(bash, () => false);
    expect(wrapped.name).toBe("bash");
    expect(wrapped.label).toBe("Bash");
    expect(wrapped.description).toBe("Test");
    expect(wrapped.parameters).toBe(bash.parameters);
  });
});

// ─── wrapAllToolsWithSeal ──────────────────────────────────────────────

describe("wrapAllToolsWithSeal", () => {
  it("wraps each tool in the list independently", async () => {
    const calls = { a: 0, b: 0 };
    const toolA = defineTool({
      name: "a",
      label: "A",
      description: "A",
      parameters: Type.Object({}),
      execute: async () => {
        calls.a += 1;
        return { content: [{ type: "text" as const, text: "a" }], details: {} };
      },
    });
    const toolB = defineTool({
      name: "b",
      label: "B",
      description: "B",
      parameters: Type.Object({}),
      execute: async () => {
        calls.b += 1;
        return { content: [{ type: "text" as const, text: "b" }], details: {} };
      },
    });

    let sealed = false;
    const wrapped = wrapAllToolsWithSeal([toolA, toolB], () => sealed);

    for (const tool of wrapped) {
      await invoke(tool, {});
    }
    expect(calls.a).toBe(1);
    expect(calls.b).toBe(1);

    sealed = true;
    for (const tool of wrapped) {
      await invoke(tool, {});
    }
    expect(calls.a).toBe(1);
    expect(calls.b).toBe(1);
  });
});

// ─── Integration: handoff → bash side effects blocked ──────────────────

describe("post-emission sealing — handoff then bash blocks side effects", () => {
  it("handoff (valid) then bash → zero bash side effects, exactly one capture", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-seal-"));
    const probeFile = join(workdir, "probe.txt");
    try {
      const callCount = { n: 0 };
      const bash = makeBash(probeFile, callCount);

      const seam = new SessionSeam();
      const handoff = createHandoffTool(seam);

      // The wrap reads the live seam flag — same one Task 14's tool
      // factory flips on first valid capture. This is exactly the
      // wiring the production Host (Task 15's sibling) will use.
      const wrappedBash = wrapToolWithSeal(bash, () => seam.isSealed);

      // 1. Model calls handoff first (valid).
      const handoffResult = await invoke(handoff, { target_role: "worker" });
      expect((handoffResult as { details: { ok: boolean } }).details.ok).toBe(true);
      expect(seam.isSealed).toBe(true);
      expect(seam.read()).toHaveLength(1);

      // 2. Model then calls bash — wrapped, sealed, must short-circuit.
      const bashResult = await invoke(wrappedBash, { cmd: "echo bash" });
      expect((bashResult as { content: { text: string }[] }).content[0]?.text).toContain(
        "session sealed",
      );

      // 3. Probe: bash did NOT write the file. stat() throws on ENOENT.
      await expect(stat(probeFile)).rejects.toThrow();

      // 4. Capture buffer still has exactly one entry (the valid handoff).
      const captures: readonly EmissionCapture[] = seam.read();
      expect(captures).toHaveLength(1);
      expect(captures[0]?.toolName).toBe("handoff");
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("bash then handoff → bash runs normally (flag not yet set)", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-seal-"));
    const probeFile = join(workdir, "probe.txt");
    try {
      const callCount = { n: 0 };
      const bash = makeBash(probeFile, callCount);

      const seam = new SessionSeam();
      const handoff = createHandoffTool(seam);
      const wrappedBash = wrapToolWithSeal(bash, () => seam.isSealed);

      // 1. Model calls bash FIRST. Seam is not yet sealed.
      expect(seam.isSealed).toBe(false);
      const bashResult = await invoke(wrappedBash, { cmd: "echo bash" });
      expect((bashResult as { content: { text: string }[] }).content[0]?.text).toBe("wrote");

      // 2. Probe: bash DID write the file.
      const s = await stat(probeFile);
      expect(s.isFile()).toBe(true);
      expect(await readFile(probeFile, "utf8")).toBe("bash ran");
      expect(callCount.n).toBe(1);

      // 3. Model then calls handoff. Seam flips to sealed.
      const handoffResult = await invoke(handoff, { target_role: "worker" });
      expect((handoffResult as { details: { ok: boolean } }).details.ok).toBe(true);
      expect(seam.isSealed).toBe(true);
      expect(seam.read()).toHaveLength(1);
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("multiple bash calls after sealing all short-circuit", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "pi-conductor-seal-"));
    try {
      const callCount = { n: 0 };
      const bash = makeBash(join(workdir, "probe.txt"), callCount);
      const seam = new SessionSeam();
      const handoff = createHandoffTool(seam);
      const wrappedBash = wrapToolWithSeal(bash, () => seam.isSealed);

      // First bash runs normally.
      await invoke(wrappedBash, { cmd: "1" });
      expect(callCount.n).toBe(1);

      // Handoff seals.
      await invoke(handoff, { target_role: "worker" });
      expect(seam.isSealed).toBe(true);

      // Three more bash calls: all blocked.
      for (let i = 0; i < 3; i++) {
        const r = await invoke(wrappedBash, { cmd: `${i + 2}` });
        expect((r as { content: { text: string }[] }).content[0]?.text).toContain("session sealed");
      }
      expect(callCount.n).toBe(1); // not incremented
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("handoff then handoff (extra_emission): first handoff sealed; second call returns extra_emission", async () => {
    // The sealing wrapper is for SIDE-EFFECTING tools. handoff / end
    // remain unwrapped so the extra_emission marker path works. After
    // the first valid handoff, isSealed is true; a SECOND handoff call
    // sees a non-empty capture buffer and writes an extra_emission
    // marker (per Task 14). This verifies the two tools coexist.
    const seam = new SessionSeam();
    const handoff = createHandoffTool(seam);

    // First handoff: valid, sealed.
    const first = await invoke(handoff, { target_role: "worker" });
    expect((first as { details: { ok: boolean } }).details.ok).toBe(true);
    expect(seam.isSealed).toBe(true);

    // Second handoff: extra_emission (Task 14's contract).
    const second = await invoke(handoff, { target_role: "reviewer" });
    expect((second as { details: { ok: boolean; reason?: string } }).details).toEqual({
      ok: false,
      reason: "extra_emission",
    });
    expect(seam.isSealed).toBe(true); // unchanged
    expect(seam.read()).toHaveLength(2); // buffer grew
  });
});
