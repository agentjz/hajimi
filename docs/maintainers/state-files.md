# 状态文件说明

## 为什么要看这个

这个项目很多关键行为不是靠内存，而是靠根目录状态文件。

维护时，先搞清楚这些文件分别是什么，再改代码。

## `.hajimi/tasks/`

每个任务一个 JSON。

关注字段：

- `status`
- `blockedBy`
- `blocks`
- `assignee`
- `owner`
- `checklist`
- `worktree`

它是任务控制面的真相源。

## `.hajimi/team/config.json`

队友列表和状态：

- `working`
- `idle`
- `shutdown`

它不记录正式协商，只记录成员状态。

## `.hajimi/team/requests/`

正式协议请求。

当前是：

- plan approval
- shutdown

这部分才是“协商状态真相”。

## `.hajimi/team/policy.json`

lead 的机器级协作闸门。

当前字段：

- `allowPlanDecisions`
- `allowShutdownRequests`

## `.hajimi/team/inbox/*.jsonl`

瞬时投递层。

消息会被读取和 drain，不适合作为唯一真相源。

## `.hajimi/team/messages.jsonl`

消息审计层。

普通消息和协议消息都会写入这里。

## `.hajimi/worktrees/index.json`

记录 worktree 索引。

重点是：

- `taskId`
- `path`
- `branch`
- `status`

## `.hajimi/worktrees/events.jsonl`

记录 worktree 生命周期事件。

适合调试：

- create before/after
- remove before/after
- remove failed

## 维护时的原则

如果一个行为影响协作、任务、审批、目录绑定，请先想：

- 它应该落到哪个状态文件？
- 哪个 store 才是它的真相源？

不要让多个文件同时承担同一种真相。
