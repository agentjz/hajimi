# 代码地图

## 为什么需要这篇

维护者最常见的问题不是“不知道功能”，而是“不知道该改哪层”。

这篇文档只做一件事：告诉你每个目录大概负责什么。

## 顶层目录

### `src/agent/`

主循环、上下文压缩、verification、runtime state、最终收口。

如果你要改：

- turn loop
- context 策略
- todo / verification 注入
- 全局运行时行为

先看这里。

### `src/tools/`

模型可见操作面。

这里只做：

- 参数解析
- 机器约束检查
- 调用下层能力

不要把核心真相都塞进这里。

### `src/tasks/`

任务控制面。

负责：

- 任务状态
- 依赖关系
- assignee / owner
- checklist

### `src/team/`

多 agent 协作控制面。

负责：

- 队友状态
- inbox 消息
- 协议请求
- coordination policy
- teammate worker 循环

### `src/background/`

后台作业状态与 worker。

### `src/worktrees/`

任务和隔离目录绑定。

### `src/subagent/`

一次性子智能体，而不是长期 teammate。

### `src/context/`

项目上下文发现：

- repo root
- AGENTS
- skills

### `src/config/`

配置读取、环境变量、路径。

### `src/ui/`

CLI 输出与交互层。

### `tests/`

骨架回归测试。

## 常见修改场景

### 想加一个新工具

先看：

- `src/tools/`
- `src/tools/registry.ts`

### 想改任务协作逻辑

先看：

- `src/tasks/store.ts`
- `src/team/worker.ts`
- `src/tools/tasks/`

### 想改审批 / shutdown / 协议行为

先看：

- `src/team/requestStore.ts`
- `src/team/policyStore.ts`
- `src/tools/team/`

### 想改上下文压缩 / 计划 / verification

先看：

- `src/agent/contextBuilder.ts`
- `src/agent/runTurn.ts`
- `src/agent/finalize.ts`

### 想改 worktree 生命周期

先看：

- `src/worktrees/store.ts`
- `src/tools/worktrees/`

## 一条维护原则

如果你发现自己准备同时改很多目录，先停一下，问自己：

- 这次改动真正的真相源在哪一层？

先找对层，再动手。
