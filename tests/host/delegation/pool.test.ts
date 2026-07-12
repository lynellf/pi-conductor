/**
 * Tests for delegation/pool.ts — bounded concurrency pool.
 */

import { describe, expect, test } from "vitest";
import { PoolConcurrencyError, runBounded } from "../../../src/host/delegation/pool.js";

describe("runBounded", () => {
  test("returns results in input order", async () => {
    const results = await runBounded({
      items: ["a", "b", "c"],
      maxParallel: 3,
      run: async (item) => item.toUpperCase(),
    });
    expect(results.map((r) => (r.ok ? (r as { ok: true; value: string }).value : null))).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  test("maxParallel = 1: runs sequentially", async () => {
    const order: string[] = [];
    await runBounded({
      items: ["a", "b", "c"],
      maxParallel: 1,
      run: async (item) => {
        order.push(`start-${item}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end-${item}`);
        return item;
      },
    });
    expect(order).toEqual(["start-a", "end-a", "start-b", "end-b", "start-c", "end-c"]);
  });

  test("maxParallel = 2: enforces concurrency cap", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    await runBounded({
      items: ["a", "b", "c", "d"],
      maxParallel: 2,
      run: async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 20));
        currentConcurrent--;
        return "done";
      },
    });
    expect(maxConcurrent).toBe(2);
  });

  test("mixed success and failure: failures do NOT cancel siblings", async () => {
    const results = await runBounded({
      items: ["ok", "fail", "ok2"],
      maxParallel: 3,
      run: async (item) => {
        if (item === "fail") throw new Error("intentional");
        return item;
      },
    });
    expect(results.length).toBe(3);
    expect(results[0]?.ok).toBe(true);
    expect((results[0] as { ok: true; value: string }).value).toBe("ok");
    expect(results[1]?.ok).toBe(false);
    expect((results[1] as { ok: false; reason: unknown }).reason).toBeInstanceOf(Error);
    expect(results[2]?.ok).toBe(true);
    expect((results[2] as { ok: true; value: string }).value).toBe("ok2");
  });

  test("empty items array returns empty results", async () => {
    const results = await runBounded({
      items: [],
      maxParallel: 5,
      run: async () => "unused",
    });
    expect(results).toEqual([]);
  });

  test("maxParallel = items.length: all run concurrently", async () => {
    let maxConcurrent = 0;
    let current = 0;
    await runBounded({
      items: ["a", "b"],
      maxParallel: 2,
      run: async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise((r) => setTimeout(r, 20));
        current--;
        return "x";
      },
    });
    expect(maxConcurrent).toBe(2);
  });

  test("throws PoolConcurrencyError for maxParallel <= 0", async () => {
    await expect(
      runBounded({ items: ["a"], maxParallel: 0, run: async () => "x" }),
    ).rejects.toThrow(PoolConcurrencyError);
    await expect(
      runBounded({ items: ["a"], maxParallel: -1, run: async () => "x" }),
    ).rejects.toThrow(PoolConcurrencyError);
  });

  test("run receives correct index", async () => {
    const indices: number[] = [];
    await runBounded({
      items: ["a", "b", "c"],
      maxParallel: 2,
      run: async (_item, index) => {
        indices.push(index);
        return index;
      },
    });
    expect(indices.sort()).toEqual([0, 1, 2]);
  });
});
