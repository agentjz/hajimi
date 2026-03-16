# Hajimi

Hajimi 是一个**终端优先的开源 AI 智能体框架**。

它不只是”在命令行里聊天”，而是把模型、工具、任务板、后台任务、队友协作、协议状态机、worktree 隔离这些能力组合成一套可维护的系统。

这个项目适合两类人：

- **普通用户**：想在终端里分析代码、修改文件、跑命令、完成多步任务
- **维护者 / AI 维护者**：想继续扩展一套多智能体 CLI 架构，而不是维护一个只能 demo 的脚本

## 这个项目的优势

### 1. 不只是聊天，而是完整的 agent loop

- 一个主循环驱动工具调用
- 工具注册化，不需要每加一个工具就拆主循环
- 先计划，再执行，再验证，而不是想到哪做到哪

### 2. 不只是单智能体，而是多智能体协作

- 队友可以长期存在，不是一次性子任务
- 有异步邮箱和正式协议，不靠自由文本瞎协商
- 队友可以自己看任务板、自己认领任务

### 3. 不只是能改代码，而是能长期维护

- 任务图落盘
- 后台任务落盘
- 协议请求落盘
- worktree 状态落盘
- 关键骨架已经有自动化测试保护

### 4. 不只是 prompt engineering，而是机器层约束

- 计划不是只靠提醒词
- 审批不是只靠模型自觉
- 任务归属不是只靠 prompt 约定
- 关键协作规则已经收敛到状态机和持久化真相源

## 适合做什么

- 代码阅读与项目分析
- 多步修改与验证
- 长时间任务拆解与执行
- 多 agent 协作实验
- 终端 AI agent 架构研究

## 核心原则（12 条）
- 一个循环驱动工具调用
- 工具注册化，循环不改
- 先计划再动手（强制 `todo_write`）
- 子任务独立上下文
- 技能按需加载，不污染系统提示
- 三层压缩，延长会话
- 任务图落盘，支持协作
- 慢操作后台执行
- 队友协作 + 异步邮箱
- 统一通信协议
- 队友自认领任务
- worktree 隔离目录

## 安装

### 方式一：NPM 全局安装

```powershell
npm install -g @jun133/hajimi
hajimi init
hajimi
```

### 方式二：Git Clone / 源码安装

```powershell
git clone <your-repo-url>
cd hajimi
npm install
npm run build
npm link
hajimi init
hajimi
```

### `.env` 最小示例

`hajimi init` 会生成 `.env` 和 `.hajimiignore`。`.env` 可直接改成这样：

```text
HAJIMI_API_KEY=replace-with-your-key
HAJIMI_BASE_URL=https://api.deepseek.com
HAJIMI_MODEL=deepseek-reasoner
```

也可以把 `HAJIMI_BASE_URL` / `HAJIMI_MODEL` 指到其他 OpenAI 兼容提供方。

### 全局运行

```powershell
hajimi
hajimi "帮我看看这个项目是做什么的"
```

如果你的 PowerShell 对执行有拦截，可以用：

```powershell
hajimi.cmd
```

### 卸载

```powershell
npm uninstall -g @jun133/hajimi
```

如果你是源码 `npm link` 安装的：

```powershell
npm unlink -g @jun133/hajimi
```

## 模式

- `agent`：默认模式；允许编辑文件、补丁修改、回滚、运行 shell；仍受允许目录约束
- `read-only`：只做读取、分析、总结，不做改文件、回滚、shell 执行

### 临时切换模式

```powershell
hajimi --mode read-only
hajimi --mode agent
hajimi --mode agent "帮我修这个 bug"
```

### 持久切换模式

```powershell
hajimi config set mode read-only
hajimi config set mode agent
hajimi config get mode
hajimi config show
```

## 命令速查

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `hajimi` | 进入交互模式 |
| `hajimi "<prompt>"` | 新建会话，执行一次 |
| `hajimi run "<prompt>"` | 显式执行单次任务 |
| `hajimi resume [sessionId]` | 继续最近一次或指定会话 |
| `hajimi sessions [-n 20]` | 查看最近会话 |
| `hajimi init` | 在当前项目生成 `.env` 和 `.hajimiignore` |
| `hajimi remote` | 启动局域网远程聊天页（直连访问 + SSE 阶段式时间线） |
| `hajimi changes [changeId] [-n 20]` | 查看变更记录或单条变更 |
| `hajimi undo [changeId]` | 回滚最近一次或指定变更 |
| `hajimi diff [path]` | 查看当前项目的 Git diff |
| `hajimi doctor` | 检查本地环境和 API 连接 |

### 配置命令

| 命令 | 说明 |
| --- | --- |
| `hajimi config show` | 查看当前配置和 API Key 状态 |
| `hajimi config path` | 显示配置文件路径 |
| `hajimi config get <key>` | 读取配置项 |
| `hajimi config set <key> <value>` | 设置配置项 |

### 全局参数

| 参数 | 说明 |
| --- | --- |
| `-m, --model <model>` | 临时覆盖模型 |
| `--mode <read-only\|agent>` | 临时切换模式 |
| `-C, --cwd <path>` | 指定本次运行的工作目录 |

### 内部命令

下面两个命令是 CLI 内部工作进程使用的，普通用户一般不用手动调用：

- `hajimi __worker__ background --job-id <id>`
- `hajimi __worker__ teammate --name <name> --role <role> --prompt <prompt>`

## 常见用法

### 先分析，再决定要不要改

```powershell
hajimi --mode read-only "先分析这个项目结构，再告诉我该怎么改"
hajimi --mode agent
```

### 查看和回滚改动

```powershell
hajimi diff
hajimi changes
hajimi undo
```

### 继续会话

```powershell
hajimi sessions
hajimi resume
hajimi resume <sessionId>
```

### 局域网远程控制

```powershell
hajimi remote
```

这会启动一个同 WiFi 可访问的手机聊天式控制页，并在终端打印：

- 局域网 URL

手机端页面现在是：

- 直接打开就能进入，不需要 token
- 中文聊天式主界面“哈基米远程”
- 初始空对话 + 顶部 `新建对话`
- 底部输入框 + `发送` / `停止`
- SSE 推送的阶段式时间线：用户输入、思考过程、工具使用、最终回答

远程模式的详细说明见：

- `docs/user/remote.md`
- `docs/maintainers/remote-mode.md`
- `docs/maintainers/mcp.md`

## 文件能力

- 文本文件：读取、搜索、修改、补丁式改写
- Word：支持 `read_docx` / `write_docx` / `edit_docx`
- 表格：支持 `xlsx/xls/csv/tsv/ods`
- 项目规则：支持项目级 `AGENTS.md` / `SKILL.md`
- 不直接强读：`.doc`、`.pdf`、`.pptx` 和大多数二进制文件

## 发布到 NPM

```powershell
npm login
npm whoami
npm run check
npm version patch
npm publish
```

较大更新可以改用：

```powershell
npm version minor
npm publish
```

## docs

更详细的设计和演进过程在 `docs/`：

- `docs/README.md`
- `docs/user/README.md`
- `docs/user/remote.md`
- `docs/maintainers/README.md`
- `docs/maintainers/remote-mode.md`
- `docs/maintainers/mcp.md`
- `docs/principles/README.md`
- `docs/principles/S01-一个循环一个智能体.md`
- `docs/principles/S02-加一个工具只加一个处理器.md`
- `docs/principles/S03-先计划再动手.md`
- `docs/principles/S04-大任务拆给子智能体.md`
- `docs/principles/S05-知识按需加载.md`
- `docs/principles/S06-上下文要能压缩.md`
- `docs/principles/S07-任务图要落盘.md`
- `docs/principles/S08-慢操作放后台.md`
- `docs/principles/S09-任务太大就分给队友.md`
- `docs/principles/S10-队友之间要有统一协议.md`
- `docs/principles/S11-队友自己认领任务.md`
- `docs/principles/S12-工作区和任务要隔离.md`
