/** Issue #139: bound optional packet display without changing durable evidence or process facts. */
import {
  type RenderPacketOptions,
  renderPhaseWorkPacket,
  utf8Bytes,
} from "./phase-work-packet-render.js";
import type { PhaseWorkPacketOmission } from "./phase-work-packet-schema.js";

function incrementOmission(
  omissions: PhaseWorkPacketOmission[],
  kind: string,
  count: number,
): void {
  const index = omissions.findIndex((entry) => entry.kind === kind);
  const prior = omissions[index];
  if (prior === undefined) omissions.push({ kind, count });
  else omissions[index] = { ...prior, count: (prior.count ?? 1) + count };
}

/** Keep full structured sources; only shrink the rendered view, with byte-accounted omissions. */
export function renderBoundedPhaseWorkPacket(
  options: Omit<RenderPacketOptions, "dropReportedNarrative" | "summarizeCutoff">,
  maxBytes: number,
): { rendered: string; omissions: PhaseWorkPacketOmission[] } {
  let omissions = options.omissions.slice();
  let hostObserved = options.hostObserved;
  let dropReportedNarrative = false;
  let summarizeCutoff = false;
  const render = (compact = summarizeCutoff, counts = omissions) =>
    renderPhaseWorkPacket({
      ...options,
      hostObserved,
      omissions: counts,
      dropReportedNarrative,
      summarizeCutoff: compact,
    });
  let rendered = render();

  // Cutoff keys are an evidence index, not process state. Preserve their full
  // array in the record and name the dispatch source plus digest/count in text.
  if (utf8Bytes(rendered) > maxBytes && options.header.cutoff_record_keys.length > 0) {
    const compactOmissions = omissions.slice();
    incrementOmission(
      compactOmissions,
      "cutoff_keys_summarized",
      options.header.cutoff_record_keys.length,
    );
    const compact = render(true, compactOmissions);
    if (utf8Bytes(compact) < utf8Bytes(rendered)) {
      summarizeCutoff = true;
      omissions = compactOmissions;
      rendered = compact;
    }
  }
  if (utf8Bytes(rendered) > maxBytes) {
    if (!omissions.some((entry) => entry.kind === "reported_narrative_truncated"))
      incrementOmission(omissions, "reported_narrative_truncated", 1);
    dropReportedNarrative = true;
    rendered = render();
  }
  while (utf8Bytes(rendered) > maxBytes) {
    if (hostObserved.verification.length > 0) {
      hostObserved = { ...hostObserved, verification: hostObserved.verification.slice(1) };
      incrementOmission(omissions, "verification_dropped", 1);
    } else if (hostObserved.commands.length > 0) {
      hostObserved = { ...hostObserved, commands: hostObserved.commands.slice(1) };
      incrementOmission(omissions, "commands_dropped", 1);
    } else if ((hostObserved.evidence_refs?.length ?? 0) > 0) {
      hostObserved = { ...hostObserved, evidence_refs: hostObserved.evidence_refs?.slice(1) ?? [] };
      incrementOmission(omissions, "evidence_refs_dropped", 1);
    } else if (
      hostObserved.worktree.kind === "snapshot" &&
      hostObserved.worktree.dirty_paths.length > 0
    ) {
      hostObserved = {
        ...hostObserved,
        worktree: {
          ...hostObserved.worktree,
          dirty_paths: hostObserved.worktree.dirty_paths.slice(1),
        },
      };
      incrementOmission(omissions, "dirty_paths_dropped", 1);
    } else {
      // An irreducible identity/process/blocker cannot be silently truncated.
      // The existing strict persistence boundary rejects an over-budget record.
      break;
    }
    // Count/footer changes are part of the bytes being checked, not an afterthought.
    rendered = render();
  }
  return { rendered, omissions };
}
