import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import * as pi from "@earendil-works/pi-coding-agent";

/** Create the CLI's credential/catalog owner across the Pi model-runtime migration. */
export async function createCliModelRegistry(): Promise<ModelRegistry> {
  // Pi 0.84+ replaced AuthStorage/ModelRegistry.create with an async runtime
  // and a synchronous registry facade. Retain the pinned 0.80.6 SDK path.
  // https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md#model
  if (
    "ModelRuntime" in pi &&
    typeof pi.ModelRuntime === "function" &&
    "create" in pi.ModelRuntime &&
    typeof pi.ModelRuntime.create === "function"
  ) {
    const runtime: unknown = await pi.ModelRuntime.create();
    // The pinned development types describe only the former private constructor.
    const registry: unknown = Reflect.construct(pi.ModelRegistry, [runtime]);
    if (!(registry instanceof pi.ModelRegistry)) {
      throw new Error("Pi ModelRegistry did not create a registry facade");
    }
    return registry;
  }
  return pi.ModelRegistry.create(pi.AuthStorage.create());
}
