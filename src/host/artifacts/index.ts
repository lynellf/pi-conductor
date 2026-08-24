/**
 * Artifact pipeline — issue #48 T5.
 *
 * Exports:
 * - `collect.ts`: terminal collection (validation, caps, copy, auto-patch)
 * - `route.ts`: materialization + seed artifacts section + orchestrator re-routing
 */

export { collectAutoPatch, collectDeclaredArtifacts, type CollectionResult } from "./collect.js";
export {
  buildOrchestratorReroute,
  formatArtifactsSeedSection,
  materializeArtifacts,
} from "./route.js";
