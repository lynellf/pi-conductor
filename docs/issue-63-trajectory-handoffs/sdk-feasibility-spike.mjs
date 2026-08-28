import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const usage = {
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const requests = [];
let sourceExecutions = 0;
let targetExecutions = 0;
let targetProviderTurns = 0;
let currentRolePrompt = "SOURCE_ROLE_ONLY";

function toolCallStream(model, context, calls) {
  requests.push({
    model: model.id,
    systemPrompt: context.systemPrompt,
    toolNames: (context.tools ?? []).map((tool) => tool.name),
    messages: structuredClone(context.messages),
  });
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "spike",
    model: model.id,
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: message });
  calls.forEach((call, index) => {
    const toolCall = { type: "toolCall", id: `${model.id}-${index}`, name: call, arguments: {} };
    message.content.push(toolCall);
    stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
    stream.push({ type: "toolcall_delta", contentIndex: index, delta: "{}", partial: message });
    stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
  });
  stream.push({ type: "done", reason: "toolUse", message });
  stream.end();
  return stream;
}

function stopStream(model, context) {
  requests.push({
    model: model.id,
    systemPrompt: context.systemPrompt,
    toolNames: (context.tools ?? []).map((tool) => tool.name),
    messages: structuredClone(context.messages),
  });
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "TARGET_FINAL" }],
    api: "anthropic-messages",
    provider: "spike",
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: message });
  stream.push({ type: "text_start", contentIndex: 0, partial: message });
  stream.push({ type: "text_delta", contentIndex: 0, delta: "TARGET_FINAL", partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: "TARGET_FINAL", partial: message });
  stream.push({ type: "done", reason: "stop", message });
  stream.end();
  return stream;
}

function streamSimple(model, context) {
  if (model.id === "source") return toolCallStream(model, context, ["source_tool"]);
  if (model.id === "target") {
    targetProviderTurns += 1;
    return targetProviderTurns === 1
      ? toolCallStream(model, context, ["source_tool", "target_tool"])
      : stopStream(model, context);
  }
  if (model.id === "tiny") return stopStream(model, context);
  throw new Error(`unexpected model ${model.id}`);
}

function model(id, contextWindow, maxTokens = 16) {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "spike",
    baseUrl: "spike://no-network",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

async function makeLoader(cwd) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "BASE_PROMPT_SHOULD_NOT_SURVIVE_ROLE_SWAP",
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      {
        name: "trajectory-role-environment",
        factory: (pi) => {
          pi.on("before_agent_start", async () => ({ systemPrompt: currentRolePrompt }));
        },
      },
    ],
  });
  await loader.reload();
  return loader;
}

function sourceTool() {
  return defineTool({
    name: "source_tool",
    label: "Source",
    description: "source-only tool",
    parameters: Type.Object({}),
    execute: async () => {
      sourceExecutions += 1;
      return {
        content: [{ type: "text", text: "SOURCE_TOOL_RESULT_EXACT" }],
        details: { source: true },
        terminate: true,
      };
    },
  });
}

function targetTool() {
  return defineTool({
    name: "target_tool",
    label: "Target",
    description: "target-only tool",
    parameters: Type.Object({}),
    execute: async () => {
      targetExecutions += 1;
      return {
        content: [{ type: "text", text: "TARGET_TOOL_RESULT" }],
        details: { target: true },
        terminate: true,
      };
    },
  });
}

class TrajectoryContextAdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TrajectoryContextAdmissionError";
    this.code = code;
  }
}

function admitTrajectoryContext(session, targetModel, targetSeedTokens) {
  if (
    !Number.isSafeInteger(targetModel.contextWindow) ||
    targetModel.contextWindow <= 0 ||
    !Number.isSafeInteger(targetModel.maxTokens) ||
    targetModel.maxTokens < 0
  ) {
    throw new TrajectoryContextAdmissionError(
      "trajectory_context_metadata_unknown",
      "target contextWindow/maxTokens metadata is unknown",
    );
  }
  const usage = session.getContextUsage();
  if (usage === undefined || usage.tokens === null) {
    throw new TrajectoryContextAdmissionError(
      "trajectory_context_unknown",
      "Pi cannot estimate this session context before generation",
    );
  }
  const required = usage.tokens + targetSeedTokens + targetModel.maxTokens;
  if (required > targetModel.contextWindow) {
    throw new TrajectoryContextAdmissionError(
      "trajectory_context_too_large",
      `requires ${required} tokens but target window is ${targetModel.contextWindow}`,
    );
  }
  return { required, contextWindow: targetModel.contextWindow };
}

function assertTrajectory(request) {
  const roles = request.messages.map((message) => message.role);
  assert.deepEqual(roles.slice(0, 3), ["user", "assistant", "toolResult"]);
  assert.equal(request.messages[0].content[0].text, "SOURCE_PROMPT_EXACT");
  assert.equal(request.messages[1].content[0].name, "source_tool");
  assert.equal(request.messages[2].toolName, "source_tool");
  assert.equal(request.messages[2].content[0].text, "SOURCE_TOOL_RESULT_EXACT");
}

const cwd = await mkdtemp(join(tmpdir(), "issue-63-sdk-spike-"));
try {
  const auth = AuthStorage.inMemory();
  const registry = ModelRegistry.inMemory(auth);
  const source = model("source", 1000);
  const target = model("target", 1000);
  const tiny = model("tiny", 1);
  registry.registerProvider("spike", {
    baseUrl: "spike://no-network",
    api: "anthropic-messages",
    apiKey: "not-a-live-key",
    streamSimple,
    models: [source, target, tiny],
  });
  const sessionDir = join(cwd, "sessions");
  const manager = SessionManager.create(cwd, sessionDir);
  const loader = await makeLoader(cwd);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    model: source,
    thinkingLevel: "low",
    modelRegistry: registry,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: manager,
    customTools: [sourceTool(), targetTool()],
    tools: ["source_tool", "target_tool"],
  });

  const originalSessionId = session.sessionId;
  const originalSessionFile = session.sessionFile;
  await session.prompt("SOURCE_PROMPT_EXACT");
  assert.equal(sourceExecutions, 1);

  await session.setModel(target);
  session.setThinkingLevel("high");
  currentRolePrompt = "TARGET_ROLE_ONLY";
  session.setActiveToolsByName(["target_tool"]);
  assert.equal(session.sessionId, originalSessionId);
  assert.equal(session.sessionFile, originalSessionFile);
  assert.equal(session.model?.id, "target");
  assert.equal(session.thinkingLevel, "high");
  assert.deepEqual(session.getActiveToolNames(), ["target_tool"]);

  const targetSeedBudget = 10;
  const admissionKnown = admitTrajectoryContext(session, target, targetSeedBudget);
  assert.equal(admissionKnown.contextWindow, 1000);

  await session.prompt("TARGET_PROMPT_EXACT");
  const targetRequest = requests.find((request) => request.model === "target");
  assert.ok(targetRequest);
  assertTrajectory(targetRequest);
  assert.equal(session.systemPrompt, "TARGET_ROLE_ONLY");
  assert.equal(targetRequest.systemPrompt, "TARGET_ROLE_ONLY");
  assert.deepEqual(targetRequest.toolNames, ["target_tool"]);
  assert.equal(sourceExecutions, 1);
  assert.equal(targetExecutions, 1);

  await session.setModel(tiny);
  let admissionTooLarge;
  assert.throws(
    () => admitTrajectoryContext(session, tiny, targetSeedBudget),
    (error) => {
      admissionTooLarge = { code: error.code, message: error.message };
      return error instanceof TrajectoryContextAdmissionError && error.code === "trajectory_context_too_large";
    },
  );

  session.dispose();

  const resumedLoader = await makeLoader(cwd);
  const { session: resumed } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRegistry: registry,
    resourceLoader: resumedLoader,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    sessionManager: SessionManager.open(originalSessionFile, sessionDir, cwd),
    customTools: [sourceTool(), targetTool()],
    tools: ["source_tool", "target_tool"],
  });
  assert.equal(resumed.sessionId, originalSessionId);
  assert.equal(resumed.sessionFile, originalSessionFile);
  assert.deepEqual(resumed.messages, session.messages);
  assert.equal(resumed.model?.id, "tiny");
  resumed.setActiveToolsByName(["target_tool"]);
  assert.deepEqual(resumed.getActiveToolNames(), ["target_tool"]);
  const firstEntryId = resumed.sessionManager.getEntries()[0]?.id;
  assert.ok(firstEntryId);
  resumed.sessionManager.appendCompaction("spike summary", firstEntryId, 0);
  let admissionUnknown;
  assert.throws(
    () => admitTrajectoryContext(resumed, target, targetSeedBudget),
    (error) => {
      admissionUnknown = { code: error.code, message: error.message };
      return error instanceof TrajectoryContextAdmissionError && error.code === "trajectory_context_unknown";
    },
  );
  resumed.dispose();

  console.log(
    JSON.stringify(
      {
        package: "@earendil-works/pi-coding-agent",
        sessionId: originalSessionId,
        sessionFile: originalSessionFile,
        messageRolesAfterSource: ["user", "assistant", "toolResult"],
        sourceRequest: {
          model: requests[0]?.model,
          systemPrompt: requests[0]?.systemPrompt,
          toolNames: requests[0]?.toolNames,
        },
        targetRequest: {
          model: targetRequest.model,
          systemPrompt: targetRequest.systemPrompt,
          toolNames: targetRequest.toolNames,
          messageRoles: targetRequest.messages.map((message) => message.role),
        },
        sourceExecutions,
        targetExecutions,
        admissionKnown,
        admissionTooLarge,
        admissionUnknown,
        resumed: { sessionId: resumed.sessionId, sessionFile: resumed.sessionFile, model: resumed.model?.id },
        result: "PASS",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(cwd, { recursive: true, force: true });
}
