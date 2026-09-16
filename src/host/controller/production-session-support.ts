/** Small production-session identity and private-root helpers. */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ControllerActivationStartedRecord } from "../../persistence/controller-records.js";
import { assertPrivateAdmissionDirectory } from "../execution/sandbox/admission-metadata.js";
import { canonicalTrustedSnapshotParent } from "../execution/sandbox/runtime-capture.js";
import type { RuntimeHostProtection } from "../execution/sandbox/runtime-types.js";
import {
  type ApprovedControllerDefinition,
  approveControllerDefinition,
  verifyControllerApproval,
} from "./approved-definition.js";
import type { ControllerHostApproval } from "./host-approval.js";
import type { ProductionControllerSessionOptions } from "./production-session-factory.js";
import type { ControllerRecoveryPlan } from "./recovery-contract.js";

export function approvedProductionDefinition(
  options: ProductionControllerSessionOptions,
  approval: ControllerHostApproval,
): ApprovedControllerDefinition {
  const config = options.loadedManifest.manifest.controller;
  if (config === undefined) throw new Error("controller configuration is missing");
  const definitions = options.log
    .records(options.runId)
    .filter((record) => record.type === "controller_definition_pinned");
  if (definitions.length > 1) throw new Error("controller definition is duplicated");
  const pinned = definitions[0];
  if (pinned?.type === "controller_definition_pinned") {
    const verified = verifyControllerApproval(pinned, approval);
    const requested = approveControllerDefinition(options.runId, config, approval, pinned.ts);
    if (requested.record.definition_digest !== pinned.definition_digest)
      throw new Error("pinned controller definition does not match the run manifest");
    return verified;
  }
  const created = approveControllerDefinition(options.runId, config, approval, Date.now());
  options.persist(created.record);
  return created;
}

export function productionActivationRecord(
  definition: ApprovedControllerDefinition,
  recovery: ControllerRecoveryPlan,
): ControllerActivationStartedRecord {
  return {
    type: "controller_activation_started",
    schema_version: 1,
    run_id: definition.record.run_id,
    controller_id: definition.record.controller_id,
    definition_digest: definition.record.definition_digest,
    activation_id: randomUUID(),
    owner_epoch: recovery.nextOwnerEpoch,
    reason:
      recovery.previousActivationId === null
        ? "start"
        : recovery.freshActionRequired.length > 0
          ? "resume_after_repair"
          : "resume",
    previous_activation_id: recovery.previousActivationId,
    ts: Date.now(),
  };
}

export function productionHostProtection(
  primaryCheckout: string,
  runStateDir: string,
): RuntimeHostProtection {
  return {
    primaryCheckout,
    stateRoots: [runStateDir],
    childWorkspaceRoots: [join(runStateDir, "worktrees"), join(runStateDir, "sandbox")],
  };
}

export async function initializeControllerRunState(runStateDir: string): Promise<void> {
  await canonicalTrustedSnapshotParent(runStateDir);
  for (const path of [join(runStateDir, "worktrees"), join(runStateDir, "sandbox")]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await assertPrivateAdmissionDirectory(path);
  }
}
