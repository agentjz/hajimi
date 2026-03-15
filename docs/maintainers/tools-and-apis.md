# 工具层与内部 API

## 工具层是什么

`src/tools/` 是模型可见的操作面。

它的职责不是保存真相，而是：

- 解析参数
- 做权限和状态校验
- 调用下层 store / worker / utils
- 把结果序列化返回给模型

## 当前分组

- `src/tools/files/`
- `src/tools/documents/`
- `src/tools/tasks/`
- `src/tools/team/`
- `src/tools/worktrees/`
- `src/tools/background/`
- `src/tools/shell/`
- `src/tools/skills/`

共享层仍在 `src/tools/` 根目录：

- `registry.ts`
- `shared.ts`
- `types.ts`
- `changeTracking.ts`

## 工具层最重要的规则

### 1. 工具不要自己发明新状态

如果要持久化状态，优先写到：

- `TaskStore`
- `ProtocolRequestStore`
- `CoordinationPolicyStore`
- `BackgroundJobStore`
- `WorktreeStore`

### 2. 工具要做机器校验，不要只靠 prompt

例如：

- `planApprovalTool` 会检查 coordination policy
- `shutdownRequestTool` 会检查 coordination policy
- `taskUpdateTool` 会拦截 teammate 直接改 owner / assignee

### 3. 工具返回结果要服务于后续运行时

例如：

- `claim_task` 现在返回 worktree 信息
- `todo_write` 现在返回同步后的 `taskId`

## 内部 API 设计习惯

### Store API

适合保存真相、读写状态。

### Tool API

适合模型调用。

### Runtime API

适合全局注入、调度、汇总。

## 什么时候该新建工具

当模型需要一个明确动作，且这个动作：

- 有清晰输入输出
- 不适合塞进 prompt
- 不适合让模型自己拼 shell

就应该新建工具。

## 什么时候不该新建工具

如果只是某个 store 的小细节，先考虑是不是应该：

- 扩展已有工具
- 扩展已有 store
- 扩展 runtime state

不要把每个小需求都变成新工具。
