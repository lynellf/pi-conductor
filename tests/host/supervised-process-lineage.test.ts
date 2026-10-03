import { describe, expect, it } from "vitest";
import {
  classifyObservationGap,
  isObservationGapReason,
  type LineageContext,
  type LineageNode,
} from "../../src/host/execution/supervised-process-lineage.js";

const OWNER_UID = 1000;
const FOREIGN_UID = 0;

function namespace(...nodes: readonly LineageNode[]): ReadonlyMap<number, LineageNode> {
  return new Map(nodes.map((node) => [node.pid, node]));
}

function node(
  pid: number,
  parentPid: number,
  uid: number = OWNER_UID,
  startTime = String(1000 + pid),
): LineageNode {
  return { pid, parentPid, uid, startTime };
}

// Lineage shape used by the shared cases: tool root 100 under shell 50, sshd
// session 20 (same UID), root-privileged listener 10, init 1.
const SHARED = namespace(
  node(1, 0, FOREIGN_UID, "1"),
  node(10, 1, FOREIGN_UID, "2"),
  node(20, 10, OWNER_UID, "3"),
  node(50, 20, OWNER_UID, "4"),
  node(100, 50, OWNER_UID, "100"),
);
const CONTEXT: LineageContext = {
  root: { pid: 100, startTime: "100" },
  ancestors: [
    node(50, 20, OWNER_UID, "4"),
    node(20, 10, OWNER_UID, "3"),
    node(10, 1, FOREIGN_UID, "2"),
    node(1, 0, FOREIGN_UID, "1"),
  ],
};

describe("classifyObservationGap", () => {
  const cases: readonly {
    readonly name: string;
    readonly nodes: ReadonlyMap<number, LineageNode>;
    readonly lineage: LineageContext;
    readonly candidate: number;
    readonly expectedKind: "external" | "unresolved";
    readonly expectedReason: string;
  }[] = [
    {
      name: "skips a session daemon that is an ancestor of the tool root (sshd)",
      nodes: SHARED,
      lineage: CONTEXT,
      candidate: 20,
      expectedKind: "external",
      expectedReason: "lineage_ancestor",
    },
    {
      name: "skips a same-UID process whose live parent is foreign-UID (sshd@notty)",
      nodes: namespace(node(300, 200), node(200, 1, FOREIGN_UID, "2")),
      lineage: CONTEXT,
      candidate: 300,
      expectedKind: "external",
      expectedReason: "foreign_uid_parent",
    },
    {
      name: "skips a disjoint same-UID tree rooted at an unrelated daemon",
      nodes: namespace(node(400, 401), node(401, 402), node(402, 1)),
      lineage: CONTEXT,
      candidate: 400,
      expectedKind: "external",
      expectedReason: "disjoint_tree",
    },
    {
      name: "skips a tree that leaves the tool UID space mid-chain (other-session client)",
      nodes: namespace(node(400, 401), node(401, 402), node(402, 1, FOREIGN_UID, "2")),
      lineage: CONTEXT,
      candidate: 400,
      expectedKind: "external",
      expectedReason: "foreign_uid_parent",
    },
    {
      name: "retains a grandchild descendant of the tool root",
      nodes: new Map([...SHARED, [150, node(150, 100)], [151, node(151, 150)]]),
      lineage: CONTEXT,
      candidate: 151,
      expectedKind: "unresolved",
      expectedReason: "descendant",
    },
    {
      name: "retains a direct child of the tool root",
      nodes: new Map([...SHARED, [150, node(150, 100)]]),
      lineage: CONTEXT,
      candidate: 150,
      expectedKind: "unresolved",
      expectedReason: "descendant",
    },
    {
      name: "retains the tool root itself",
      nodes: SHARED,
      lineage: CONTEXT,
      candidate: 100,
      expectedKind: "unresolved",
      expectedReason: "descendant",
    },
    {
      name: "retains an orphan reparented to init (double-fork escape shape)",
      nodes: new Map([...SHARED, [600, node(600, 1)]]),
      lineage: CONTEXT,
      candidate: 600,
      expectedKind: "unresolved",
      expectedReason: "orphan",
    },
    {
      name: "retains an orphan held by a same-UID tool ancestor (subreaper shape)",
      nodes: new Map([...SHARED, [700, node(700, 50)]]),
      lineage: CONTEXT,
      candidate: 700,
      expectedKind: "unresolved",
      expectedReason: "ambiguous_lineage",
    },
    {
      name: "retains a candidate whose parent vanished mid-walk",
      nodes: new Map([...SHARED, [800, node(800, 999)]]),
      lineage: CONTEXT,
      candidate: 800,
      expectedKind: "unresolved",
      expectedReason: "incomplete_snapshot",
    },
    {
      name: "retains everything without captured root ancestry",
      nodes: SHARED,
      lineage: { root: { pid: 100, startTime: "100" }, ancestors: [] },
      candidate: 20,
      expectedKind: "unresolved",
      expectedReason: "incomplete_snapshot",
    },
    {
      name: "retains a candidate with no snapshot entry",
      nodes: SHARED,
      lineage: CONTEXT,
      candidate: 999,
      expectedKind: "unresolved",
      expectedReason: "incomplete_snapshot",
    },
    {
      name: "refuses a recycled root pid with a different start time",
      nodes: namespace(node(150, 100), node(100, 1, OWNER_UID, "999")),
      lineage: { root: { pid: 100, startTime: "100" }, ancestors: [node(50, 1, OWNER_UID, "4")] },
      candidate: 150,
      expectedKind: "external",
      expectedReason: "disjoint_tree",
    },
    {
      name: "retains a cyclic parent chain instead of looping",
      nodes: new Map([...SHARED, [70, node(70, 71)], [71, node(71, 70)]]),
      lineage: CONTEXT,
      candidate: 70,
      expectedKind: "unresolved",
      expectedReason: "incomplete_snapshot",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const classification = classifyObservationGap(
        testCase.candidate,
        testCase.lineage,
        testCase.nodes,
        OWNER_UID,
      );
      expect(classification.kind).toBe(testCase.expectedKind);
      expect(classification.reason).toBe(testCase.expectedReason);
    });
  }
});

describe("classifyObservationGap with a verified subreaper host (#157 option 1)", () => {
  const REAPERED: LineageContext = { ...CONTEXT, subreaperPid: 50 };
  const cases: readonly {
    readonly name: string;
    readonly nodes: ReadonlyMap<number, LineageNode>;
    readonly lineage: LineageContext;
    readonly candidate: number;
    readonly expectedKind: "external" | "unresolved";
    readonly expectedReason: string;
  }[] = [
    {
      name: "skips a same-session client under a shared ancestor above the reaper host",
      nodes: namespace(...SHARED.values(), node(600, 20)),
      lineage: REAPERED,
      candidate: 600,
      expectedKind: "external",
      expectedReason: "disjoint_tree",
    },
    {
      name: "keeps a direct child of the reaper host unresolved (adopted escape)",
      nodes: namespace(...SHARED.values(), node(600, 50)),
      lineage: REAPERED,
      candidate: 600,
      expectedKind: "unresolved",
      expectedReason: "ambiguous_lineage",
    },
    {
      name: "skips an init orphan when the host is the verified reaper",
      nodes: namespace(node(600, 1)),
      lineage: REAPERED,
      candidate: 600,
      expectedKind: "external",
      expectedReason: "disjoint_tree",
    },
    {
      name: "keeps an init orphan unresolved without a verified reaper",
      nodes: namespace(node(600, 1)),
      lineage: CONTEXT,
      candidate: 600,
      expectedKind: "unresolved",
      expectedReason: "orphan",
    },
    {
      name: "keeps the ambiguity when the claimed reaper is absent from the ancestry",
      nodes: namespace(...SHARED.values(), node(600, 20)),
      lineage: { ...CONTEXT, subreaperPid: 999 },
      candidate: 600,
      expectedKind: "unresolved",
      expectedReason: "ambiguous_lineage",
    },
    {
      name: "keeps a descendant unresolved even with the reaper active",
      nodes: namespace(...SHARED.values(), node(605, 100)),
      lineage: REAPERED,
      candidate: 605,
      expectedKind: "unresolved",
      expectedReason: "descendant",
    },
    {
      name: "keeps an ancestor below the reaper host ambiguous (closer reaper possible)",
      nodes: namespace(node(600, 90), node(90, 100)),
      lineage: {
        root: { pid: 100, startTime: "100" },
        ancestors: [
          node(90, 100),
          node(50, 20, OWNER_UID, "4"),
          node(20, 10, OWNER_UID, "3"),
          node(10, 1, FOREIGN_UID, "2"),
        ],
        subreaperPid: 50,
      },
      candidate: 600,
      expectedKind: "unresolved",
      expectedReason: "ambiguous_lineage",
    },
  ];
  for (const { name, nodes, lineage, candidate, expectedKind, expectedReason } of cases) {
    it(name, () => {
      expect(classifyObservationGap(candidate, lineage, nodes, OWNER_UID)).toEqual({
        kind: expectedKind,
        reason: expectedReason,
      });
    });
  }
});

describe("isObservationGapReason", () => {
  it("accepts exactly the seven verdict names", () => {
    for (const reason of [
      "lineage_ancestor",
      "foreign_uid_parent",
      "disjoint_tree",
      "descendant",
      "orphan",
      "ambiguous_lineage",
      "incomplete_snapshot",
    ])
      expect(isObservationGapReason(reason)).toBe(true);
    for (const value of ["descend", "", 7, null, undefined, "EXTERNAL"])
      expect(isObservationGapReason(value)).toBe(false);
  });
});
