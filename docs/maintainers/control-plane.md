# 控制面设计

## 控制面是什么

控制面不直接改文件，也不直接跑命令。

控制面只负责回答：

- 该做什么
- 谁该做
- 谁能批准
- 哪些任务/协议/作业正在进行中

## 当前控制面由什么组成

### `TaskStore`

职责：任务真相源。

关键字段：

- `status`
- `blockedBy`
- `blocks`
- `assignee`
- `owner`
- `checklist`
- `worktree`

### `ProtocolRequestStore`

职责：所有正式协商的真相源。

当前承载：

- `plan_approval`
- `shutdown`

### `CoordinationPolicyStore`

职责：lead 协作闸门。

当前承载：

- 是否允许做 plan decision
- 是否允许发 shutdown request

### `BackgroundJobStore`

职责：后台作业索引与状态。

### `WorktreeStore`

职责：任务与隔离目录绑定关系。

## 当前最重要的统一原则

### 1. 任务分配不能只靠 prompt

现在机器层用：

- `assignee` 表示谁该做
- `owner` 表示谁正在做

### 2. 正式协商不能只靠普通消息

现在机器层用：

- inbox 做投递
- `messages.jsonl` 做审计
- `ProtocolRequestStore` 做正式状态机

### 3. lead 行为不能只靠自觉

现在机器层用：

- `CoordinationPolicyStore` 明确开关审批和 shutdown 权限

## 维护建议

以后如果再新增“需要正式协商”的能力，优先问：

- 它是不是新的协议类型？
- 它是不是新的 coordination gate？
- 它是不是新的 task / worktree 状态？

不要优先想“system prompt 里加一句”。
