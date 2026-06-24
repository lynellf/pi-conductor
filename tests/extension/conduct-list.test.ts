/**
 * Phase 7B Task 7B.3 — `/conduct:list` handler.
 *
 * The plan's 7B.3 acceptance: "List renders run
 * summaries without reaching into log internals." This
 * file covers the validation + empty-list branches;
 * the rich-summary rendering is exercised by the E2E
 * (which leaves a run in the file log and asserts
 * `listRuns` sees it).
 *
 * Companion tests:
 *   - `conduct-registration.test.ts` — Task 7B.1
 *   - `conduct-start.test.ts` — Task 7B.2
 *   - `conduct-resume.test.ts` — Task 7B.3 (resume)
 *   - `conduct-abort.test.ts` — Task 7B.3 (abort)
 *   - `conduct-e2e.test.ts` — Task 7B.4 (E2E)
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadExtension, makeCtx, type NotifyCall } from "./conduct-harness.js";

describe("extension shell — Task 7B.3: /conduct:list", () => {
  let cwd: string;
  let notifyCalls: NotifyCall[];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-conductor-conduct-list-"));
    notifyCalls = [];
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("notifies when the manifest is missing (same rule as /conduct)", async () => {
    // Pass homeDir: "" to disable the HOME fallback — hermetic test.
    const ext = await loadExtension("<test>", cwd, "");
    const list = ext.commands.get("conduct:list");
    expect(list).toBeDefined();
    await list?.handler(
      "",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );
    const manifestWarnings = notifyCalls.filter(
      (n) => n.type === "warning" && /manifest/i.test(n.msg),
    );
    expect(manifestWarnings).toHaveLength(1);
  });

  it("notifies 'no runs' when the base dir is empty", async () => {
    // Write a valid manifest. The handler will load
    // it and find no runs.
    const piDir = join(cwd, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "conductor.yaml"),
      "version: 1\nroles:\n  - name: orchestrator\n    is_orchestrator: true\n    system_prompt: .pi/roles/orchestrator.md\n    tools: [handoff, end]\n  - name: worker\n    max_visits: 3\n    system_prompt: .pi/roles/worker.md\n    tools: [handoff, end]\n",
      "utf8",
    );
    const ext = await loadExtension("<test>", cwd);
    const list = ext.commands.get("conduct:list");
    expect(list).toBeDefined();
    await list?.handler(
      "",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );
    const noRuns = notifyCalls.find((n) => n.type === "info" && /No runs found/i.test(n.msg));
    expect(noRuns).toBeDefined();
  });

  it("appends a transition trace to each per-run line (AC4)", async () => {
    // Phase 8 / handoff-visibility: `/conduct:list`
    // renders the run's transition trace after the
    // existing fields. The trace is sourced from the
    // `transitionHistory` projection of the
    // persisted records.
    //
    // We seed a synthetic run log with two
    // `transition_accepted` records (handoff +
    // end). The handler reads them via
    // `FileRecordLog.records(runId)` and projects
    // them through `runStats().transitionHistory`.
    const piDir = join(cwd, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "conductor.yaml"),
      "version: 1\nroles:\n  - name: orchestrator\n    is_orchestrator: true\n    system_prompt: .pi/roles/orchestrator.md\n    tools: [handoff, end]\n  - name: worker\n    max_visits: 3\n    system_prompt: .pi/roles/worker.md\n    tools: [handoff, end]\n",
      "utf8",
    );
    // Create the run log directory + a synthetic
    // JSONL with a handoff + an end record +
    // checkpoint snapshot (so `runStats` finds a
    // current_role for the line).
    const runsDir = join(cwd, ".pi-conductor", "runs");
    await mkdir(runsDir, { recursive: true });
    const runId = "list-trace-test-1";
    const records = [
      {
        type: "transition_accepted",
        run_id: runId,
        from: "orchestrator",
        to: "worker",
        event: "handoff",
        target_role: "worker",
        role: "orchestrator",
        suggests_next: null,
        payload_summary: { field_names: [] },
        guard: null,
        effect: [],
        session_file: "stub",
        ts: 1,
      },
      {
        type: "transition_accepted",
        run_id: runId,
        from: "worker",
        to: "orchestrator",
        event: "handoff",
        target_role: "orchestrator",
        role: "worker",
        suggests_next: null,
        payload_summary: { field_names: [] },
        guard: null,
        effect: [],
        session_file: "stub",
        ts: 2,
      },
      {
        type: "transition_accepted",
        run_id: runId,
        from: "orchestrator",
        to: "done",
        event: "end",
        target_role: null,
        role: "orchestrator",
        suggests_next: null,
        payload_summary: { field_names: [] },
        guard: null,
        effect: [],
        session_file: "stub",
        ts: 3,
      },
      {
        type: "checkpoint_snapshot",
        checkpoint: {
          run_id: runId,
          manifest_version: "1",
          current_role: "done",
          visit_count: { worker: 1 },
          active_role_session: null,
          updated_at: 3,
        },
      },
    ];
    const lines = records.map((r) => JSON.stringify(r)).join("\n");
    await writeFile(join(runsDir, `${runId}.jsonl`), `${lines}\n`, "utf8");

    const ext = await loadExtension("<test>", cwd);
    const list = ext.commands.get("conduct:list");
    expect(list).toBeDefined();
    await list?.handler(
      "",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );
    const summary = notifyCalls.find((n) => n.type === "info" && /Runs in /.test(n.msg));
    expect(summary).toBeDefined();
    // The line includes the runId prefix, the
    // existing fields (state, exitReason, cost), and
    // the appended transition trace.
    expect(summary?.msg).toContain(
      `${runId} · done · done · $0.000 · orchestrator → worker → orchestrator → done`,
    );
  });

  it("renders the active declared model token in list output", async () => {
    const piDir = join(cwd, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "conductor.yaml"),
      "version: 1\nroles:\n  - name: orchestrator\n    is_orchestrator: true\n    system_prompt: .pi/roles/orchestrator.md\n    tools: [handoff, end]\n  - name: worker\n    max_visits: 3\n    system_prompt: .pi/roles/worker.md\n    tools: [handoff, end]\n",
      "utf8",
    );
    const runsDir = join(cwd, ".pi-conductor", "runs");
    await mkdir(runsDir, { recursive: true });
    const runId = "list-model-test-1";
    const sessionFile = "/tmp/list-model-test-1.jsonl";
    const records = [
      {
        type: "session_started",
        run_id: runId,
        role: "worker",
        visit_index: 1,
        state: "worker",
        model: "stub:primary",
        model_effort: "high",
        session_file: sessionFile,
        parent_session: null,
        ts: 1,
      },
      {
        type: "checkpoint_snapshot",
        checkpoint: {
          run_id: runId,
          manifest_version: "1",
          current_role: "worker",
          visit_count: { worker: 1 },
          active_role_session: {
            id: "session-1",
            role: "worker",
            session_file: sessionFile,
          },
          updated_at: 2,
        },
      },
    ];
    await writeFile(
      join(runsDir, `${runId}.jsonl`),
      `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );

    const ext = await loadExtension("<test>", cwd);
    const list = ext.commands.get("conduct:list");
    expect(list).toBeDefined();
    await list?.handler(
      "",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );
    const summary = notifyCalls.find((n) => n.type === "info" && /Runs in /.test(n.msg));
    expect(summary?.msg).toContain(
      `${runId} · worker · running · $0.000 · model=stub:primary · effort=high`,
    );
  });

  it("renders model=<default> for an active session with a null model", async () => {
    const piDir = join(cwd, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "conductor.yaml"),
      "version: 1\nroles:\n  - name: orchestrator\n    is_orchestrator: true\n    system_prompt: .pi/roles/orchestrator.md\n    tools: [handoff, end]\n  - name: worker\n    max_visits: 3\n    system_prompt: .pi/roles/worker.md\n    tools: [handoff, end]\n",
      "utf8",
    );
    const runsDir = join(cwd, ".pi-conductor", "runs");
    await mkdir(runsDir, { recursive: true });
    const runId = "list-default-model-test-1";
    const sessionFile = "/tmp/list-default-model-test-1.jsonl";
    const records = [
      {
        type: "session_started",
        run_id: runId,
        role: "worker",
        visit_index: 1,
        state: "worker",
        model: null,
        session_file: sessionFile,
        parent_session: null,
        ts: 1,
      },
      {
        type: "checkpoint_snapshot",
        checkpoint: {
          run_id: runId,
          manifest_version: "1",
          current_role: "worker",
          visit_count: { worker: 1 },
          active_role_session: {
            id: "session-1",
            role: "worker",
            session_file: sessionFile,
          },
          updated_at: 2,
        },
      },
    ];
    await writeFile(
      join(runsDir, `${runId}.jsonl`),
      `${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );

    const ext = await loadExtension("<test>", cwd);
    const list = ext.commands.get("conduct:list");
    expect(list).toBeDefined();
    await list?.handler(
      "",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );
    const summary = notifyCalls.find((n) => n.type === "info" && /Runs in /.test(n.msg));
    expect(summary?.msg).toContain(
      `${runId} · worker · running · $0.000 · model=<default> · effort=medium`,
    );
  });

  it("renders an empty history gracefully (no trailing arrow)", async () => {
    // A run with no transitions yet (e.g., a
    // crashed run before any handoff) should NOT
    // render a trailing `· → …` or stray `→`. The
    // trace is empty, the existing fields are
    // preserved, and there's no orphan separator.
    const piDir = join(cwd, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "conductor.yaml"),
      "version: 1\nroles:\n  - name: orchestrator\n    is_orchestrator: true\n    system_prompt: .pi/roles/orchestrator.md\n    tools: [handoff, end]\n  - name: worker\n    max_visits: 3\n    system_prompt: .pi/roles/worker.md\n    tools: [handoff, end]\n",
      "utf8",
    );
    const runsDir = join(cwd, ".pi-conductor", "runs");
    await mkdir(runsDir, { recursive: true });
    const runId = "list-empty-trace-1";
    // Only a checkpoint snapshot — no transitions.
    const records = [
      {
        type: "checkpoint_snapshot",
        checkpoint: {
          run_id: runId,
          manifest_version: "1",
          current_role: "orchestrator",
          visit_count: {},
          active_role_session: null,
          updated_at: 0,
        },
      },
    ];
    const lines = records.map((r) => JSON.stringify(r)).join("\n");
    await writeFile(join(runsDir, `${runId}.jsonl`), `${lines}\n`, "utf8");

    const ext = await loadExtension("<test>", cwd);
    const list = ext.commands.get("conduct:list");
    expect(list).toBeDefined();
    await list?.handler(
      "",
      makeCtx({
        cwd,
        notify: (msg, type) => notifyCalls.push({ msg, type }),
      }),
    );
    const summary = notifyCalls.find((n) => n.type === "info" && /Runs in /.test(n.msg));
    expect(summary).toBeDefined();
    // The line is the existing fields, no
    // transition trace appended. No `→` anywhere in
    // the per-run line.
    expect(summary?.msg).toContain(`${runId} · orchestrator · running · $0.000`);
    // Strip the prefix `Runs in <baseDir>: ` and
    // assert no `→` in the per-run portion.
    const tail = summary?.msg.split(": ")[1] ?? "";
    expect(tail).not.toMatch(/→/);
  });
});
