import { collectMcpRegisteredTools } from "../mcp/registryIntegration.js";
import type { RuntimeConfig } from "../types.js";
import { createToolRegistry } from "./registry.js";
import type { ToolRegistry, ToolRegistryOptions } from "./types.js";

export async function createRuntimeToolRegistry(
  config: RuntimeConfig,
  options: ToolRegistryOptions = {},
): Promise<ToolRegistry> {
  const mcpTools = await collectMcpRegisteredTools(config.mcp);

  return createToolRegistry(config.mode, {
    ...options,
    includeTools: [...(options.includeTools ?? []), ...mcpTools],
  });
}
