import { resolveMcpServerDefinitions } from "./config.js";
import { createPlaceholderMcpClient, discoverMcpServers, type McpClientFactory } from "./discovery.js";
import type { McpConfig, McpDiscoverySnapshot, McpDiscoveredTool } from "./types.js";

export class McpClientManager {
  private snapshots: McpDiscoverySnapshot[] = [];

  constructor(
    private readonly config: McpConfig,
    private readonly clientFactory: McpClientFactory = createPlaceholderMcpClient,
  ) {}

  async refresh(): Promise<McpDiscoverySnapshot[]> {
    if (!this.config.enabled) {
      this.snapshots = [];
      return this.snapshots;
    }

    const servers = resolveMcpServerDefinitions(this.config);
    this.snapshots = await discoverMcpServers(servers, this.clientFactory);
    return this.getSnapshots();
  }

  getSnapshots(): McpDiscoverySnapshot[] {
    return this.snapshots.map((snapshot) => ({
      ...snapshot,
      tools: [...snapshot.tools],
      instructions: [...snapshot.instructions],
      diagnostics: [...snapshot.diagnostics],
    }));
  }

  getDiscoveredTools(): McpDiscoveredTool[] {
    return this.snapshots.flatMap((snapshot) => snapshot.tools);
  }
}
