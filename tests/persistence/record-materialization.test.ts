import { describe, expect, it } from "vitest";

import type { SessionLifecycleEvent } from "../../src/core/types.js";
import { InMemoryRecordLog } from "../../src/persistence/log.js";

const workspace = {
  backend: "worktree",
  guarantee: "confined" as const,
  path_or_image: "/tmp/isolated",
};

function terminalRecord(type: "session_ended" | "session_failed"): object {
  return {
    type,
    run_id: "run-1",
    role: "isolated",
    visit_index: 1,
    state: "isolated",
    model: "anthropic:claude-sonnet-4-5",
    session_file: "/tmp/isolated.jsonl",
    parent_session: null,
    usage: {
      input: 1,
      output: 1,
      cache_read: 0,
      cache_write: 0,
      tokens: 2,
      cost: 0.01,
    },
    workspace,
    ts: 1,
  };
}

describe("lifecycle workspace record materialization", () => {
  it.each([
    "session_ended",
    "session_failed",
  ] as const)("rejects confined workspace metadata on %s before retaining the terminal record", (type) => {
    const log = new InMemoryRecordLog();

    expect(() => log.append(terminalRecord(type) as never)).toThrow(
      "workspace metadata is only allowed on session_started",
    );
    expect(log.records("run-1")).toEqual([]);
  });

  it("retains a valid session_started workspace unchanged", () => {
    const log = new InMemoryRecordLog();
    const started: SessionLifecycleEvent = {
      type: "session_started",
      run_id: "run-1",
      role: "isolated",
      visit_index: 1,
      state: "isolated",
      model: "anthropic:claude-sonnet-4-5",
      session_file: "/tmp/isolated.jsonl",
      parent_session: null,
      workspace,
      ts: 1,
    };

    log.append(started);

    expect(log.records("run-1")).toEqual([started]);
  });
});
