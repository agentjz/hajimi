# 维护者文档

这组文档是给维护者看的，默认读者包括：

- 人类维护者
- AI 维护者
- 以后会继续改这个项目的人

它不是用户说明书，而是这套系统的**维护说明书**。

## 先看什么

### 第一层：先建立整体模型

1. `architecture-overview.md`
2. `loop-and-runtime.md`
3. `control-plane.md`
4. `protocols.md`
5. `code-map.md`
6. `remote-mode.md`
7. `mcp.md`

### 第二层：看状态和接口

8. `state-files.md`
9. `tools-and-apis.md`

### 第三层：看测试和改法

10. `testing.md`

## 维护原则

- 优先维护**机器层约束**，不要优先依赖 prompt 约束
- 优先维护**状态真相源**，不要引入平行状态
- 优先维护**控制面 / 执行面分离**，不要把调度逻辑塞进工具细节
- 优先改根因，不要靠临时补丁掩盖结构问题

## 和 12 条原则的关系

`docs/principles/` 是原则层。

`docs/maintainers/` 是实现层。

如果你想知道“为什么这样设计”，看原则层。

如果你想知道“代码现在到底怎么组织、改哪里”，看维护者文档。
