import { PlaceholderMcpClient } from "./client.js";
import type { McpClient, McpDiscoverySnapshot, ResolvedMcpServerDefinition } from "./types.js";

export type McpClientFactory = (server: ResolvedMcpServerDefinition) => McpClient;

export async function discoverMcpServers(
  servers: ResolvedMcpServerDefinition[],
  clientFactory: McpClientFactory = createPlaceholderMcpClient,
): Promise<McpDiscoverySnapshot[]> {
  const discoveries: McpDiscoverySnapshot[] = [];

  for (const server of servers) {
    if (!server.enabled) {
      discoveries.push({
        server,
        status: "disabled",
        tools: [],
        instructions: [],
        diagnostics: [`MCP server "${server.name}" is disabled in config.`],
        updatedAt: new Date().toISOString(),
      });
      continue;
    }

    const client = clientFactory(server);
    try {
      discoveries.push(await client.discover());
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  return discoveries;
}

export function createPlaceholderMcpClient(server: ResolvedMcpServerDefinition): McpClient {
  return new PlaceholderMcpClient(server);
}
