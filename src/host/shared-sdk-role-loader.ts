import {
  DefaultResourceLoader,
  type ExtensionFactory,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** Build the shared role resource loader with host-owned prompt/settings overrides. */
export function createSharedRoleResourceLoader(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly settingsManager: SettingsManager | undefined;
  readonly getSystemPrompt: () => string | undefined;
  readonly extensionFactories?: readonly ExtensionFactory[];
}): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    ...(options.settingsManager !== undefined && { settingsManager: options.settingsManager }),
    systemPromptOverride: options.getSystemPrompt,
    extensionFactories: [
      ...(options.extensionFactories ?? []),
      {
        name: "conductor-trajectory-role-environment",
        factory: (pi) => {
          const roleEnvironment = pi as unknown as {
            on(
              event: "before_agent_start",
              handler: () => Promise<{ systemPrompt: string | undefined }>,
            ): void;
          };
          roleEnvironment.on("before_agent_start", async () => ({
            systemPrompt: options.getSystemPrompt(),
          }));
        },
      },
    ],
  });
}
