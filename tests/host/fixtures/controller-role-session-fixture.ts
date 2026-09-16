import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControllerActionDispatcher } from "../../../src/host/controller/action-dispatcher-contract.js";
import { ControllerActivationFence } from "../../../src/host/controller/activation-fence.js";
import { createControllerRoleSession } from "../../../src/host/controller/role-session.js";
import type { DelegationAdmissionService } from "../../../src/host/delegation/admission-service.js";
import { notifyListeners } from "../../../src/host/record-emitter.js";
import type {
  ControllerRequest,
  ControllerResponse,
} from "../../../src/manifest/controller-protocol.js";
import {
  type ControllerActivationStartedRecord,
  type ControllerDefinitionPinnedRecord,
  controllerDefinitionDigest,
} from "../../../src/persistence/controller-records.js";
import type { PersistedRecord } from "../../../src/persistence/log.js";

export async function controllerSessionFixture(options: {
  readonly invokePlanner: (
    request: ControllerRequest,
    signal: AbortSignal,
  ) => Promise<ControllerResponse>;
  readonly dispatcher?: Partial<ControllerActionDispatcher>;
  readonly admission?: Partial<DelegationAdmissionService>;
  readonly isRunCostCapReached?: () => boolean;
  readonly closeOwnedWork?: () => Promise<void>;
  readonly runtime?: (context: {
    readonly activation: ControllerActivationStartedRecord;
    readonly records: PersistedRecord[];
    readonly persist: (record: PersistedRecord) => void;
    readonly fence: ControllerActivationFence;
    readonly wake: () => void;
  }) => {
    readonly dispatcher: ControllerActionDispatcher;
    readonly admission: DelegationAdmissionService;
  };
}) {
  const root = await mkdtemp(join(tmpdir(), "controller-role-session-"));
  const definitionBase = {
    type: "controller_definition_pinned" as const,
    schema_version: 1 as const,
    run_id: `run-${Date.now()}-${Math.random()}`,
    controller_id: "controller",
    pinned_definition: {},
    controller_authority: authority(),
    adapter_authorities: [],
    limits: { max_decisions: 100, max_actions: 100, max_outstanding_actions: 64 },
    ts: 1,
  };
  const definition: ControllerDefinitionPinnedRecord = {
    ...definitionBase,
    definition_digest: controllerDefinitionDigest(definitionBase),
  };
  const activation: ControllerActivationStartedRecord = {
    type: "controller_activation_started",
    schema_version: 1,
    run_id: definition.run_id,
    controller_id: definition.controller_id,
    definition_digest: definition.definition_digest,
    activation_id: "activation-1",
    owner_epoch: 1,
    reason: "start",
    previous_activation_id: null,
    ts: 2,
  };
  const records: PersistedRecord[] = [definition, activation];
  const persist = (record: PersistedRecord) => {
    records.push(record);
    notifyListeners(record);
  };
  const fence = new ControllerActivationFence(activation, () => records);
  let sessionWake: () => void = () => undefined;
  const runtime = options.runtime?.({
    activation,
    records,
    persist,
    fence,
    wake: () => sessionWake(),
  });
  const dispatcher = runtime?.dispatcher ?? stubDispatcher(options.dispatcher);
  const admission = runtime?.admission ?? { ...stubAdmission(), ...options.admission };
  const session = await createControllerRoleSession({
    role: "orchestrator",
    sessionId: "controller-session-1",
    sessionFile: join(root, "controller.jsonl"),
    activation,
    readRecords: () => records,
    persist,
    invokePlanner: options.invokePlanner,
    dispatcher,
    fence,
    maxParallel: 2,
    admission,
    isRunCostCapReached: options.isRunCostCapReached ?? (() => false),
    closeOwnedWork: options.closeOwnedWork ?? (async () => undefined),
  });
  sessionWake = () => session.wake();
  return { root, definition, activation, records, persist, dispatcher, admission, fence, session };
}

export function response(
  request: ControllerRequest,
  decision: "wait" | "finish",
): ControllerResponse {
  const common = {
    protocol_version: 1 as const,
    run_id: request.run_id,
    controller_id: request.controller_id,
    definition_digest: request.definition_digest,
    activation_id: request.activation_id,
    owner_epoch: request.owner_epoch,
    state_revision: request.state_revision,
    event_cursor: request.page_cursor,
    state: request.state,
  };
  return decision === "wait"
    ? { ...common, decision: "wait" }
    : { ...common, decision: "finish", payload: { reason: "controller complete" } };
}

function stubDispatcher(
  overrides: Partial<ControllerActionDispatcher> = {},
): ControllerActionDispatcher {
  return {
    validateReferences: async () => undefined,
    dispatchCommitted: () => undefined,
    settle: async () => undefined,
    getAction: () => null,
    getAcceptedSubmission: () => null,
    getEvents: () => ({ events: [], page_cursor: null, hasMore: false }),
    read: async () => {
      throw new Error("unused");
    },
    resolveRef: async () => {
      throw new Error("unused");
    },
    pendingCount: () => 0,
    ...overrides,
  };
}

function stubAdmission(): DelegationAdmissionService {
  return {
    submit: async () => [],
    status: () => [],
    wait: async () => {
      throw new Error("unused");
    },
    cancel: async () => undefined,
    remainingChildren: () => 16,
    acceptedSubmission: () => null,
  };
}

function authority() {
  return {
    registration_id: "runtime",
    approval_id: "approval",
    runtime_digest: "a".repeat(64),
    executable_digest: "b".repeat(64),
    capability_digest: "c".repeat(64),
  };
}
