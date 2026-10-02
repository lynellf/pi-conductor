/** #157 lineage proof for same-user observation gaps; pure classification over a captured namespace. */
// An EACCES on a same-UID process leaves the marker unverifiable. Descendance
// cannot be guessed from association (#105), but non-descendance can be proven
// from parent chains: fork descendants are same-UID-parented, orphans reparent
// only to ancestor subreapers or init, and ancestors predate their descendants.
// The root ancestry is captured at spawn time because the root is usually gone
// by cleanup. Assumption (documented, not verified): no foreign-UID ancestor of
// the tool root acts as a subreaper holding reparented escapes.

/** Process metadata required to reason about one parent chain. */
export interface LineageNode {
  readonly pid: number;
  readonly parentPid: number;
  readonly uid: number;
  readonly startTime: string;
}

/** The supervised tool root an escaped descendant would descend from. */
export interface LineageRoot {
  readonly pid: number;
  readonly startTime: string;
}

/** Root plus its spawn-time ancestry; the only reapers its orphans can adopt to. */
export interface LineageContext {
  readonly root: LineageRoot;
  readonly ancestors: readonly LineageNode[];
}

/** Why an observation gap was skipped as external or retained as unresolved. */
export type ObservationGapReason =
  | "lineage_ancestor"
  | "foreign_uid_parent"
  | "disjoint_tree"
  | "descendant"
  | "orphan"
  | "ambiguous_lineage"
  | "incomplete_snapshot";

/** External means proven not to descend from the tool root; unresolved stays fail-closed. */
export type ObservationGapClassification =
  | { readonly kind: "external"; readonly reason: ObservationGapReason }
  | { readonly kind: "unresolved"; readonly reason: ObservationGapReason };

const MAX_CHAIN_HOPS = 64;

function unresolved(reason: ObservationGapReason): ObservationGapClassification {
  return { kind: "unresolved", reason };
}

function external(reason: ObservationGapReason): ObservationGapClassification {
  return { kind: "external", reason };
}

function matchesRoot(node: LineageNode, root: LineageRoot): boolean {
  return node.pid === root.pid && node.startTime === root.startTime;
}

/**
 * Classify one unverifiable same-UID process against a captured tool lineage.
 * A root with no captured ancestry proves nothing and stays fail-closed (#157).
 */
export function classifyObservationGap(
  candidatePid: number,
  lineage: LineageContext,
  nodes: ReadonlyMap<number, LineageNode>,
  ownerUid: number,
): ObservationGapClassification {
  const candidate = nodes.get(candidatePid);
  if (candidate === undefined) return unresolved("incomplete_snapshot");
  // Without captured ancestry the reaper set is unknown; no external proof is
  // possible, because an orphaned escape may sit under any ancestor subreaper.
  if (lineage.ancestors.length === 0) return unresolved("incomplete_snapshot");
  if (matchesRoot(candidate, lineage.root)) return unresolved("descendant");
  // An ancestor of the tool root predates it and cannot be its descendant.
  if (lineage.ancestors.some((ancestor) => matchesRoot(candidate, ancestor))) {
    return external("lineage_ancestor");
  }
  const visited = new Set<number>([candidatePid]);
  let current: LineageNode = candidate;
  for (let hops = 0; hops < MAX_CHAIN_HOPS; hops += 1) {
    if (current.parentPid === 1) {
      // Reparented orphans land here, indistinguishable from daemonized escapes.
      return current.pid === candidatePid ? unresolved("orphan") : external("disjoint_tree");
    }
    const parent = nodes.get(current.parentPid);
    if (parent === undefined || visited.has(parent.pid)) return unresolved("incomplete_snapshot");
    visited.add(parent.pid);
    if (matchesRoot(parent, lineage.root)) return unresolved("descendant");
    // A same-UID root ancestor may be a subreaper holding a reparented escape.
    if (
      parent.uid === ownerUid &&
      lineage.ancestors.some((ancestor) => matchesRoot(parent, ancestor))
    ) {
      return unresolved("ambiguous_lineage");
    }
    // Fork descendants are same-UID-parented; a foreign-UID live parent (or
    // further ancestor short of init) leaves the tool's UID space.
    if (parent.uid !== ownerUid) return external("foreign_uid_parent");
    current = parent;
  }
  return unresolved("incomplete_snapshot");
}
