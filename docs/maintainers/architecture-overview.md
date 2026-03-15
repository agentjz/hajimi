# 架构总览

## 一句话

这个项目本质上是一个**终端里的多智能体控制系统**：

- 一个主循环驱动工具调用
- 一组持久化状态文件负责控制面
- 一组工具负责把模型意图变成可执行动作

## 主要分层

### 1. Agent 层

目录：`src/agent/`

职责：

- 驱动主循环
- 组织 system prompt
- 管理上下文压缩
- 管理 todo / verification / runtime state

### 2. Tool 层

目录：`src/tools/`

职责：

- 把模型调用映射到具体 handler
- 做参数解析、权限/状态校验
- 调用下层 store / worker / utils

### 3. 控制面状态层

目录：`src/tasks/` `src/team/` `src/background/` `src/worktrees/`

职责：

- 持久化任务、协议请求、消息、后台作业、worktree 索引
- 提供系统真相源
- 保证多个 agent 共享同一份控制面状态

### 4. 执行层

职责：

- shell
- 文件修改
- 后台进程
- teammate worker
- git worktree

## 最重要的设计边界

### 控制面

回答：

- 现在有哪些任务
- 谁该做、谁在做
- 哪些审批允许、哪些不允许
- 哪些协议请求正在 pending

### 执行面

回答：

- 文件怎么改
- 命令怎么跑
- worktree 在哪里
- 某个队友现在实际在执行什么

不要把控制面判断偷塞到执行细节里。

## 当前最重要的真相源

- `TaskStore`：任务真相源
- `ProtocolRequestStore`：协议协商真相源
- `CoordinationPolicyStore`：lead 协作闸门真相源
- `BackgroundJobStore`：后台作业真相源
- `WorktreeStore`：隔离目录真相源
- `MessageBus`：消息投递层 + 审计层

## 维护时优先保什么

优先保护这三个东西：

1. **状态一致性**
2. **控制面和执行面边界**
3. **工具层不绕过状态机**
