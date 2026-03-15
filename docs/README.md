# Hajimi CLI 文档索引

这套文档分成三类：

- **用户文档**：告诉使用者怎么安装、运行、配置
- **维护者文档**：告诉 AI / 人类维护者这套架构是怎么设计的
- **原则文档**：解释这套系统为什么这样设计

如果你是项目维护者，优先看 `docs/maintainers/`。

## 用户文档

- `user/README.md`
- `user/quick-start.md`
- `user/modes-and-commands.md`

## 原则文档

- `principles/README.md`
- `principles/S01-一个循环一个智能体.md`
- `principles/S02-加一个工具只加一个处理器.md`
- `principles/S03-先计划再动手.md`
- `principles/S04-大任务拆给子智能体.md`
- `principles/S05-知识按需加载.md`
- `principles/S06-上下文要能压缩.md`
- `principles/S07-任务图要落盘.md`
- `principles/S08-慢操作放后台.md`
- `principles/S09-任务太大就分给队友.md`
- `principles/S10-队友之间要有统一协议.md`
- `principles/S11-队友自己认领任务.md`
- `principles/S12-工作区和任务要隔离.md`

## 维护者文档

- `maintainers/README.md`
- `maintainers/architecture-overview.md`
- `maintainers/loop-and-runtime.md`
- `maintainers/control-plane.md`
- `maintainers/protocols.md`
- `maintainers/code-map.md`
- `maintainers/state-files.md`
- `maintainers/tools-and-apis.md`
- `maintainers/testing.md`

## 推荐阅读顺序

### 给用户

1. `../README.md`
2. `user/quick-start.md`
3. `user/modes-and-commands.md`

### 给维护者

1. `maintainers/README.md`
2. `principles/README.md`
3. `maintainers/architecture-overview.md`
4. `maintainers/control-plane.md`
5. `maintainers/protocols.md`
6. `maintainers/code-map.md`
7. `maintainers/state-files.md`
8. `maintainers/tools-and-apis.md`
9. `maintainers/testing.md`
