# 模式与常用命令

## 两种模式

- `agent`：默认模式；允许改文件、跑命令、做多步任务
- `read-only`：只读、分析、总结

## 常用命令

```powershell
node dist/cli.js
node dist/cli.js "<prompt>"
node dist/cli.js run "<prompt>"
node dist/cli.js resume
node dist/cli.js sessions
node dist/cli.js doctor
```

## 什么时候用 `agent`

- 你希望它修改代码
- 你希望它跑 shell / 测试
- 你希望它使用任务板、队友、worktree 等能力

## 什么时候用 `read-only`

- 你只想分析项目
- 你不想让它改任何东西
- 你只想看建议，不想执行
