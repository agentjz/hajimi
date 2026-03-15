# MCP 骨架

## 这次做了什么

这次没有接任何真实第三方 MCP server。

这次只把 Hajimi 作为 **MCP client** 的骨架铺好，并且保证未来接入时还能继续走现有 tool registry，而不是另起一套工具体系。

## 目录

新增目录：`src/mcp/`

当前模块：

- `types.ts`
- `config.ts`
- `client.ts`
- `discovery.ts`
- `clientManager.ts`
- `toolAdapter.ts`
- `registryIntegration.ts`
- `index.ts`

以及工具侧接线：

- `src/tools/runtimeRegistry.ts`

## 当前链路

### 1. 配置层

`src/mcp/types.ts` + `src/mcp/config.ts`

现在 runtime config 里已经有：

- `mcp.enabled`
- `mcp.servers[]`

server 定义预留了这些字段：

- `name`
- `enabled`
- `transport`
- `command`
- `args`
- `env`
- `cwd`
- `url`
- `include`
- `exclude`
- `timeoutMs`
- `trust`
- `auth`

这意味着以后接 stdio / SSE / streamable-http 时，配置入口不用再推倒重来。

### 2. discovery 层

`src/mcp/discovery.ts`

当前支持：

- 遍历配置里的 server 定义
- 对 disabled server 给出明确 snapshot
- 用 client factory 驱动 discovery

当前默认 factory 返回的是 `PlaceholderMcpClient`，所以默认 discovery 结果是：

- `status: "not_implemented"`
- `tools: []`
- `diagnostics` 说明真实 transport 还没接

### 3. client manager 层

`src/mcp/clientManager.ts`

当前职责：

- 刷新 discovery 结果
- 缓存 snapshots
- 提供 discovered tools 视图

以后真接 MCP SDK 时，连接生命周期、重连、增量刷新，都应该继续长在这里。

### 4. tool adapter 层

`src/mcp/toolAdapter.ts`

这层把 `McpDiscoveredTool` 变成现有 `RegisteredTool`：

- 生成符合当前工具系统的 function definition
- 复用现有 `parseArgs`
- 返回现有 `ToolExecutionResult` 兼容结构

这一层是“兼容现有 tool registry”的关键。

### 5. registry integration 层

`src/mcp/registryIntegration.ts` + `src/tools/runtimeRegistry.ts`

现在 agent run loop 不直接把 MCP 逻辑塞进 `registry.ts`，而是：

1. `createRuntimeToolRegistry(config)`
2. 先收集 MCP adapted tools
3. 再通过现有 `createToolRegistry(..., { includeTools })`

所以 MCP 仍然走的是现有 registry 入口，而不是旁路。

## 为什么现在是空骨架

这是刻意的。

当前状态证明了几件事：

1. 配置结构已经稳定
2. discovery / manager / adapter / registry 的边界已经清楚
3. 现有 tool registry 可以接收 MCP tool 适配结果
4. 后续接真实 transport 时，不需要改 agent loop 的核心形状

## TODO / Placeholder

当前明确还没做：

- 真实 stdio MCP client
- 真实 SSE / streamable HTTP transport
- OAuth / token auth
- server instructions 注入 system prompt
- prompt / resource discovery
- 动态刷新和重连
- MCP diagnostics UI

占位路径：

- `PlaceholderMcpClient.discover()` 返回 `not_implemented`
- `collectMcpRegisteredTools()` 在启用 MCP 但尚未接 transport 时返回空工具集

这保证了骨架已经在，但不会误导成“已经可以连第三方工具”。

## 未来接入建议

推荐顺序：

1. 先在 `src/mcp/client.ts` 旁边新增真实 transport client
2. 保持 `McpClient` 接口不变
3. 在 `discovery.ts` / `clientManager.ts` 接入真实 client factory
4. 把发现到的 tools 继续交给 `toolAdapter.ts`
5. 必要时再补 prompt/resource 支持

不要直接跳过 manager，把真实 MCP tool 直接塞进 `registry.ts`。

## 测试覆盖

新增测试：`tests/mcp-skeleton.test.ts`

当前测试保护三件事：

1. 默认 manager 的 discovery snapshot 会清楚地落到 `not_implemented`
2. adapter 生成的 MCP tool 能直接进入现有 tool registry
3. registry integration 可以通过 `includeTools` 挂进去，而不是绕开核心 registry
