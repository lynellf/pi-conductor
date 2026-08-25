/**
 * Artifact pipeline — issue #48 T5.
 *
 * Exports:
 * - `collect.ts`: terminal collection (validation, caps, copy, auto-patch)
 * - `route.ts`: materialization + seed artifacts section + orchestrator re-routing
 */

export { type CollectionResult, collectAutoPatch, collectDeclaredArtifacts } from "./collect.js";
export {
  ArtifactRoutingError,
  formatArtifactsSeedSection,
  materializeArtifacts,
  type RoutedArtifact,
} from "./route.js";
