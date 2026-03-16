# 远程模式维护说明

## 目标

当前 remote 的目标非常明确：

- 手机优先的聊天界面
- 直接访问，不做 token 鉴权
- 只保留聊天核心时间线
- 支持继续当前对话
- 支持从空对话重新开始
- 支持停止当前任务

不要再把 remote 扩展回“远程控制平台”。

明确不做：

- token 登录页
- 文件分享
- 文件下载
- 自动下载卡片
- 复杂的会话列表页

## 分层

### CLI 入口

文件：

- `src/remote/command.ts`
- `src/cli.ts`

职责：

- 解析 remote 配置
- 创建 `RemoteControlService`
- 启动 HTTP server
- 打印访问地址

不要把 remote 业务逻辑塞回 `src/cli.ts`。

### 协议与状态层

文件：

- `src/remote/types.ts`
- `src/remote/timeline.ts`
- `src/remote/sessionViews.ts`
- `src/remote/service.ts`

职责：

- 定义 remote 协议
- 把 agent callbacks 转成 remote 时间线
- 把历史 session 转成适合手机看的时间线
- 管理 `currentRun` 和 `lastSession`

### HTTP 暴露层

文件：

- `src/remote/httpServer.ts`

职责：

- 暴露 HTML / CSS / JS
- 暴露 `/api/state`
- 暴露 `/api/stream`
- 暴露 `/api/runs`
- 暴露 `/api/runs/current/cancel`

这里只依赖 `RemoteControlProtocol`，不要直接去拼别的业务细节。

### 前端资源层

文件：

- `src/remote/page.ts`
- `src/remote/assets.ts`
- `src/remote/web/index.html`
- `src/remote/web/remote.css`
- `src/remote/web/remote.js`
- `src/remote/web/app/*.js`

职责：

- 渲染聊天页
- 自动连接 SSE
- 维护当前空对话 / 当前会话视图
- 增量更新时间线 DOM

保持 HTML / CSS / JS 分离，不要退化成一个超大模板字符串。

## 当前事件模型

remote 仍然使用 SSE，但消费方式是“阶段完成事件”。

主要阶段：

- `user`
- `reasoning`
- `tool_use`
- `final_answer`
- `status`
- `warning`
- `error`

具体策略：

1. 用户提交 prompt 时，先插入 `user` 卡片
2. reasoning delta 只在服务端缓冲，等 `onModelWaitStop` 后一次性插入 `reasoning`
3. `onToolCall` 时插入 `tool_use` 卡片，只显示工具名和状态
4. 工具结束时只更新那张 `tool_use` 卡片
5. assistant delta 不直接推时间线
6. `onAssistantDone` 时一次性插入 `final_answer`
7. 完成 / 停止 / 失败时插入简洁状态卡片

## 会话视图约束

`src/remote/sessionViews.ts` 的目标是把历史消息重新整理成“适合手机看”的时间线：

- user 消息转成 `user`
- assistant 的 reasoning 转成 `reasoning`
- assistant 的 tool calls 转成 `tool_use`
- assistant 的最终文本转成 `final_answer`
- tool 成功输出默认不进时间线
- tool 错误只保留简洁错误卡片

不要重新把工具参数 JSON 或工具输出 JSON 大段塞回手机页面。

## 前端约束

当前前端应保持这些约束：

- 页面直接打开就是聊天页
- 默认是空对话
- 只有 `新建对话`
- 只有 `发送` / `停止`
- 只有在切换会话或收到完整新快照时才整体重绘
- 其余 SSE 更新尽量只更新单条消息节点

不要再加登录页、下载按钮、文件入口或其他偏离聊天主链路的 UI。

## 测试

`tests/remote-mode.test.ts` 当前覆盖：

- remote 配置读取
- 页面静态资源与基础运行
- 同一会话继续聊天
- 新建对话
- SSE 阶段式时间线
- 停止当前任务

如果后续改 remote 行为，先更新这里的测试，再改实现。
