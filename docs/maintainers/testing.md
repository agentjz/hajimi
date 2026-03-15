# 测试说明

## 当前测试目标

当前测试不是追求覆盖率数字，而是优先保护主骨架。

重点是保这些东西：

- 主循环和工具注册没坏
- 子智能体边界没坏
- 技能加载和上下文压缩没坏
- 任务图、后台任务没坏
- 多 agent 的邮箱、协议、策略闸门没坏
- task / worktree 闭环没坏

## 现在的测试文件

- `tests/foundations.test.ts`
- `tests/skill-and-context.test.ts`
- `tests/task-and-background.test.ts`
- `tests/team-and-policy.test.ts`
- `tests/protocol-and-runtime.test.ts`
- `tests/worktree-isolation.test.ts`

## 测试和原则的大致对应

- `s02 / s04`：`foundations.test.ts`
- `s05 / s06`：`skill-and-context.test.ts`
- `s07 / s08`：`task-and-background.test.ts`
- `s09 / s10 / s11`：`team-and-policy.test.ts` + `protocol-and-runtime.test.ts`
- `s12`：`worktree-isolation.test.ts`

## 怎么运行

```powershell
npm test
```

## 维护建议

以后补测试时，优先补这两类：

### 1. 骨架测试

保护架构原则，不让主骨架被改坏。

### 2. 缺陷回归测试

某次真实 bug 修掉以后，把那个 bug 固化成测试。

## 不建议的做法

- 为了数量堆很多价值低的小测试
- 大量依赖真实 API 的不稳定测试塞进默认 `npm test`
- 测试只验证 prompt 文案，而不验证机器状态
