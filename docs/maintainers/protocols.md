# 协议与协作规则

## 这篇文档讲什么

这篇只讲多 agent 协作时的正式协议，不讲普通文件编辑。

重点是 4 个东西：

- 普通消息
- 协议请求
- 协议响应
- 协调策略闸门

## 协议分层

### 1. 普通消息层

用途：通知、提醒、状态更新。

相关工具：

- `send_message`
- `broadcast`
- `read_inbox`

特点：

- inbox 用于投递
- `messages.jsonl` 用于审计
- 它不是正式协商的唯一真相源

### 2. 正式协议层

用途：会改变协作状态的沟通。

当前协议类型：

- `plan_approval`
- `shutdown`

正式协议一定要：

- 有 `request_id`
- 有 request / response 对应关系
- 有持久化状态

相关真相源：`ProtocolRequestStore`

### 3. 协调闸门层

用途：限制 lead 当前能不能做某些正式动作。

当前闸门：

- `allowPlanDecisions`
- `allowShutdownRequests`

相关真相源：`CoordinationPolicyStore`

## 当前协议流

### Plan approval

1. teammate 调 `plan_approval({ plan })`
2. 生成 `request_id`
3. request 落盘到 `.hajimi/team/requests/`
4. 同时投递 `protocol_request` 到 lead inbox
5. lead 只有在 policy 允许时，才能 approve / reject
6. 响应写回 request state，并投递 `protocol_response`

### Shutdown

1. lead 调 `shutdown_request`
2. request 落盘
3. 同时投递 `protocol_request`
4. teammate 决定 approve / reject
5. 若 approve，则 teammate 自己进入 `shutdown`

## 为什么普通消息和正式协议要分开

因为它们解决的问题不同：

- 普通消息解决“通知”
- 正式协议解决“状态变化”

如果把二者混在一起，系统会变成：

- 看起来能沟通
- 实际上没有真相源
- 后续很难审计和恢复

## AI 维护者最容易犯的错误

### 错误 1

用 `send_message` 代替正式审批。

### 错误 2

在 prompt 里写“先别批准”，但不加 machine gate。

### 错误 3

新增一个正式协作场景，却不接到 `ProtocolRequestStore`。

## 新增协议时怎么做

新增正式协议时，优先按这个顺序想：

1. 它是不是新的 `ProtocolRequestKind`
2. 它需不需要新的 coordination gate
3. 它的 request / response 字段最少需要哪些
4. 它应该由哪个工具暴露给模型

不要直接先写 prompt 约定。
