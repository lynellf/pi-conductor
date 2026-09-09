import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type InlineExtension,
  type ModelRegistry,
  runRpcMode,
  SessionManager,
  type SessionManager as SessionManagerType,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ModelEffort } from "../../core/types.js";
import { admitOrchestratorPrompt } from "../orchestrator-context-admission.js";
import { createOrchestratorCompactionController } from "../orchestrator-context-compaction.js";
import {
  captureCompactionSettings,
  createPinnedCompactionSettings,
} from "../orchestrator-context-settings.js";
import { requestRpcContext } from "./context-retention-bridge.js";
import { MACHINE_TOOLS_CONFIG_ENV } from "./machine-tools-config.js";
import { resolveMachineToolsExtensionPath } from "./node-role-process.js";

const configSchema = Type.Object(
  {
    cwd: Type.String({ minLength: 1 }),
    agentDir: Type.String({ minLength: 1 }),
    sessionDir: Type.String({ minLength: 1 }),
    sessionFile: Type.Optional(Type.String({ minLength: 1 })),
    conversationId: Type.Optional(Type.String({ minLength: 1 })),
    bridgeDirectory: Type.String({ minLength: 1 }),
    model: Type.Optional(Type.String({ minLength: 3 })),
    effort: Type.Union([
      Type.Literal("off"),
      Type.Literal("minimal"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
      Type.Literal("max"),
    ]),
    systemPrompt: Type.Optional(Type.String()),
    machineToolsConfigPath: Type.String({ minLength: 1 }),
    extensionPath: Type.Optional(Type.String({ minLength: 1 })),
    pinnedCompaction: Type.Object(
      {
        enabled: Type.Boolean(),
        reserveTokens: Type.Integer({ minimum: 0 }),
        keepRecentTokens: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
type ContextChildConfig = Static<typeof configSchema>;

/** Environment variable naming the trusted serialized child configuration. */
export const CONTEXT_CHILD_CONFIG_ENV = "PI_CONDUCTOR_CONTEXT_CHILD_CONFIG";

/** Trusted child bootstrap inputs for the public Pi runtime APIs. */
export interface ContextChildBootstrapOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionManager: SessionManagerType;
  readonly settingsManager?: SettingsManager;
  readonly modelRegistry?: ModelRegistry;
  readonly model?: Model<Api>;
  readonly modelName?: string;
  readonly systemPrompt?: string;
  readonly thinkingLevel?: ModelEffort;
  readonly extensionFactories?: readonly InlineExtension[];
  readonly extensionPaths?: readonly string[];
  readonly beforePrompt?: () => void | Promise<void>;
  readonly afterAdmission?: () => void | Promise<void>;
  readonly afterPrompt?: (session: AgentSession, error: unknown) => void | Promise<void>;
}

/** Run an isolated RPC child through Pi's public runtime/service bootstrap. */
export async function runContextRetentionRpcChild(
  options: ContextChildBootstrapOptions,
): Promise<never> {
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: options.agentDir,
      ...(options.settingsManager === undefined
        ? {}
        : { settingsManager: options.settingsManager }),
      ...(options.modelRegistry === undefined ? {} : { modelRegistry: options.modelRegistry }),
      ...(options.extensionFactories === undefined
        ? {}
        : {
            resourceLoaderOptions: {
              noExtensions: true,
              extensionFactories: [...options.extensionFactories],
              ...(options.extensionPaths === undefined
                ? {}
                : { additionalExtensionPaths: [...options.extensionPaths] }),
              ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
            },
          }),
    });
    const effectiveModel = resolveConfiguredModel(options, services.modelRegistry);
    const selectedModel =
      effectiveModel ??
      (await resolveCurrentModel(cwd, options, services)) ??
      (() => {
        throw new Error("context child could not resolve the current model before opening history");
      })();
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
      model: selectedModel,
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
      noTools: "builtin",
    });
    return {
      ...created,
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager: options.sessionManager,
  });
  if (options.settingsManager !== undefined) {
    const originalPrompt = runtime.session.prompt.bind(runtime.session);
    runtime.session.prompt = async (text, promptOptions) => {
      let failure: unknown;
      try {
        await options.beforePrompt?.();
        await admitOrchestratorPrompt(
          runtime.session,
          text,
          captureCompactionSettings(options.settingsManager as SettingsManager),
        );
        await options.afterAdmission?.();
        await originalPrompt(text, promptOptions);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        await options.afterPrompt?.(runtime.session, failure);
      }
    };
  }
  return runRpcMode(runtime);
}

/** Load trusted child configuration and enter the public RPC runtime. */
export async function runConfiguredContextRetentionChild(): Promise<never> {
  const path = process.env[CONTEXT_CHILD_CONFIG_ENV];
  if (path === undefined) throw new Error(`${CONTEXT_CHILD_CONFIG_ENV} is required`);
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Value.Check(configSchema, value)) throw new Error("invalid context child configuration");
  const config = value as ContextChildConfig;
  process.env[MACHINE_TOOLS_CONFIG_ENV] = config.machineToolsConfigPath;
  const settingsManager = createPinnedCompactionSettings(
    config.cwd,
    config.agentDir,
    config.pinnedCompaction,
  );
  const sessionManager =
    config.sessionFile === undefined
      ? (await import("@earendil-works/pi-coding-agent")).SessionManager.create(
          config.cwd,
          config.sessionDir,
        )
      : (await import("@earendil-works/pi-coding-agent")).SessionManager.open(
          config.sessionFile,
          config.sessionDir,
          config.cwd,
        );
  if (config.sessionFile !== undefined && sessionManager.getSessionFile() !== config.sessionFile) {
    throw new Error("context child opened a different session file than trusted configuration");
  }
  if (
    config.conversationId !== undefined &&
    sessionManager.getSessionId() !== config.conversationId
  ) {
    throw new Error("context child opened a different conversation than trusted configuration");
  }
  const controller = createOrchestratorCompactionController({
    requestId: () => `${sessionManager.getSessionId()}-${randomUUID()}`,
    onStart: (start) => requestRpcContext(config.bridgeDirectory, "start", start),
    onUsage: () => undefined,
    onObservation: (observation) =>
      requestRpcContext(config.bridgeDirectory, "outcome", {
        requestId: observation.requestId,
        beforeTip: observation.beforeTip,
        afterTip: observation.afterTip,
        beforeTokens: observation.beforeTokens,
        usage: observation.usage,
        rawUsages: observation.rawUsages,
        error: observation.error,
      }),
  });
  let settledSent = false;
  const extension: InlineExtension = {
    name: "pi-conductor-context-retention",
    factory: (pi) => {
      controller.extensionFactory(pi);
      pi.on("before_agent_start", () => {
        settledSent = false;
      });
    },
  };
  return runContextRetentionRpcChild({
    cwd: config.cwd,
    agentDir: config.agentDir,
    sessionManager,
    settingsManager,
    ...(config.model === undefined ? {} : { modelName: config.model }),
    thinkingLevel: config.effort,
    ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
    extensionFactories: [extension],
    extensionPaths: [
      resolveMachineToolsExtensionPath(),
      ...(config.extensionPath === undefined ? [] : [config.extensionPath]),
    ],
    beforePrompt: () => controller.assertHealthy(),
    afterAdmission: async () => {
      await controller.settle();
      controller.assertHealthy();
    },
    afterPrompt: async (session, promptError) => {
      if (settledSent) return;
      let failure = promptError;
      try {
        await controller.settle();
        controller.assertHealthy();
      } catch (error) {
        failure ??= error;
      }
      await requestRpcContext(config.bridgeDirectory, "settled", {
        conversationId: session.sessionId,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        leafId: session.sessionManager.getLeafId() ?? null,
        ...(failure === undefined ? {} : { error: String(failure) }),
      });
      settledSent = true;
      if (failure !== undefined && promptError === undefined) throw failure;
    },
  });
}

function resolveModelName(modelName: string, registry: ModelRegistry): Model<Api> {
  const separator = modelName.indexOf(":");
  if (separator < 1) throw new Error("context child model must use provider:id format");
  const model = registry.find(modelName.slice(0, separator), modelName.slice(separator + 1));
  if (model === undefined) throw new Error(`configured child model '${modelName}' is unavailable`);
  return model;
}

function resolveConfiguredModel(
  options: ContextChildBootstrapOptions,
  registry: ModelRegistry,
): Model<Api> | undefined {
  if (options.model !== undefined) return options.model;
  if (options.modelName !== undefined) return resolveModelName(options.modelName, registry);
  const settings = options.settingsManager;
  if (settings === undefined) return undefined;
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (provider === undefined || modelId === undefined) return undefined;
  const model = registry.find(provider, modelId);
  if (model === undefined) {
    throw new Error(`configured default model '${provider}:${modelId}' is unavailable`);
  }
  return model;
}

async function resolveCurrentModel(
  cwd: string,
  options: ContextChildBootstrapOptions,
  services: AgentSessionServices,
): Promise<Model<Api> | undefined> {
  const probeManager = SessionManager.inMemory(cwd);
  const probe = await createAgentSessionFromServices({
    services,
    sessionManager: probeManager,
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    noTools: "builtin",
  });
  const model = probe.session.model as Model<Api>;
  await probe.session.dispose();
  return model;
}
