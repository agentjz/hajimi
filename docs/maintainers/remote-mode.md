# 远程模式维护说明

## 目标

当前 remote 手机端的目标不是“字符级流式终端镜像”，而是：

- 手机优先聊天界面
- 阶段式增量 timeline
- 已插入卡片只做局部更新
- Tool use 默认只显示工具名
- Tool output 默认不把原始 JSON 丢进手机时间线
- 支持把工作区文件分享成可下载快照

## 分层

### CLI 入口

文件：

- `src/remote/command.ts`
- `src/cli.ts`

职责：

- 解析 remote 配置
- 创建 `RemoteControlService`
- 创建 token auth
- 启动 HTTP server
- 打印 LAN URL 和 token

不要把 remote 业务逻辑塞回 `src/cli.ts`。

### 协议与状态层

文件：

- `src/remote/service.ts`
- `src/remote/types.ts`
- `src/remote/sessionViews.ts`
- `src/remote/timeline.ts`

职责：

- 维护 `currentRun`、recent sessions、last session
- 把 agent callbacks 转成 remote 时间线事件
- 把历史 session 消息转成适合手机端的 timeline
- 对 `todo_write` / `remote_share_file` 这种工具做专门的 timeline 视图转换

### 文件分享层

文件：

- `src/remote/fileShares.ts`
- `src/tools/remote/remoteShareFileTool.ts`

职责：

- 为分享文件生成 shareId
- 把分享时刻的文件内容保存成快照
- 为 HTTP 下载接口提供按 shareId 读取的内容

`remote_share_file` 不走任意路径 query 下载。
HTTP 暴露的是 `/api/files/:shareId`。

### HTTP 暴露层

文件：

- `src/remote/httpServer.ts`

职责：

- 暴露 HTML / CSS / JS
- 暴露 `/api/state`
- 暴露 `/api/stream`
- 暴露 `/api/runs`
- 暴露 `/api/runs/current/cancel`
- 暴露 `/api/files/:shareId`

HTTP 层只依赖 `RemoteControlProtocol`，不要绕开 service 直连别的模块。

### 前端资源层

文件：

- `src/remote/page.ts`
- `src/remote/assets.ts`
- `src/remote/web/index.html`
- `src/remote/web/remote.css`
- `src/remote/web/remote.js`

保持 HTML / CSS / JS 分离。
不要回退成单个超大模板字符串。

## 当前事件模型

remote 仍然使用 SSE，但消费方式是“阶段完成事件”。

主要阶段：

- `user`
- `reasoning`
- `tool_use`
- `todo`
- `final_answer`
- `file_share`
- `status` / `warning` / `error`

具体策略：

1. 用户提交 prompt 时，先创建 user 卡片
2. reasoning delta 只在服务端缓冲，等 `onModelWaitStop` 后一次性插入 reasoning 卡片
3. `onToolCall` 时插入 `tool_use` 卡片，只显示工具名
4. 工具结束时只更新那张 `tool_use` 卡片的状态
5. `todo_write` 的结果转成 `todo` 卡片
6. `remote_share_file` 的结果转成 `file_share` 卡片
7. assistant delta 只更新 preview，不再推动 timeline
8. `onAssistantDone` 时一次性插入 `final_answer`
9. 完成 / 停止 / 失败时插入简洁状态卡片

## 前端增量渲染约束

`src/remote/web/remote.js` 当前做法：

- timeline 维护一个 `itemId -> DOM node` 映射
- 新卡片用 append
- 已有卡片只更新该卡片
- 只有在切换 session source 或首次 snapshot 时才 reset 整个 timeline

禁止再做：

- `replaceChildren(...items.map(...))`
- 每个 SSE 事件都整条 timeline 重绘
- assistant / reasoning 的字符级整块反复刷新

## 历史 session 视图约束

`src/remote/sessionViews.ts` 的目标是把历史消息重新整理成“适合手机看”的 timeline：

- assistant 带 `tool_calls` 时，只展示 reasoning 和 `tool_use`
- 最终 assistant 文本转成 `final_answer`
- 普通工具成功输出默认不进 timeline
- 工具错误只保留简短错误说明
- `todo_write` / `remote_share_file` 单独转成结构化卡片

这样回看上一轮会话时，也不会再看到大段工具参数和 JSON 结果。

## 文件分享链路

1. remote service 在创建 runtime tool registry 时，通过 `includeTools` 注入 `remote_share_file`
2. `remote_share_file` 只允许分享当前工作区内文件
3. 工具把文件内容保存到 `cacheDir/remote-file-shares`
4. 工具结果里返回 shareId、文件名、相对路径、大小、下载路径
5. service 把结果变成 `file_share` timeline item
6. 手机端下载按钮使用带 token 的 `fetch` 请求 `/api/files/:shareId`

前端不直接拼接磁盘路径。

## 测试

`tests/remote-mode.test.ts` 当前覆盖：

- 远程配置读取
- 页面静态资源与基础运行
- SSE 阶段式 timeline 事件
- 文件分享快照下载
- 取消当前运行

如果后续改 remote 行为，先更新这里的测试，再改实现。
