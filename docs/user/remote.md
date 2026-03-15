# 远程模式

## 适用场景

`hajimi remote` 适合这种用法：

- 电脑上正在跑 Hajimi
- 手机和电脑在同一个局域网里
- 你想在手机上像聊天一样发任务、看阶段进度、随时停止任务
- 你希望 agent 把当前工作区里的文件直接发到手机上下载

它不是远程桌面，也不是把终端原样镜像到手机上，而是一个手机优先的远程聊天控制页。

## 启动

```powershell
hajimi remote
```

终端会输出：

- 手机访问地址
- access token

第一次在手机上打开页面时，输入这个 token 即可连接。

## 手机页面现在会显示什么

新版手机端是中文聊天界面“哈基米远程”，重点是阶段式增量卡片：

- 你的消息会先出现
- 思考过程会在一个阶段完成后插入，默认折叠
- Tool use 只显示工具名，不再把参数 JSON 直接塞到时间线里
- `todo_write` 会显示成 Todo 卡片，可折叠展开
- 最终回答会正常显示，不折叠
- 任务完成、停止、失败会给出简洁状态卡片
- 文件分享成功后，会出现“文件已准备好”卡片，可以直接点下载

页面不会再在每个 SSE 事件到来时整条 timeline 反复重绘。
已经插入的卡片，只会更新它自己。

## 文件下载怎么用

你可以直接对 agent 说：

- “把这个文件发给我”
- “把刚才改的说明文档发到手机上”

remote 模式下会额外提供一个工具：

- `remote_share_file`

它会把工作区里的目标文件做成一个下载快照，而不是一直指向活文件。
所以如果 agent 后面继续修改原文件，你下载到的仍然是分享那一刻的版本。

下载流程是：

1. agent 调用 `remote_share_file`
2. remote service 记录这次文件分享
3. 手机端插入“文件已准备好”卡片
4. 点击按钮后，前端用带 token 的请求下载 `/api/files/:shareId`

卡片里会显示：

- 文件名
- 相对路径
- 大小
- 下载按钮

## 可选配置

可以在项目里的 `.hajimi/.env` 里放这些配置：

```text
HAJIMI_REMOTE_ENABLED=true
HAJIMI_REMOTE_BIND=lan
HAJIMI_REMOTE_PORT=4387
# HAJIMI_REMOTE_HOST=
# HAJIMI_REMOTE_TOKEN=replace-with-your-shared-token
# HAJIMI_REMOTE_PUBLIC_URL=
```

说明：

- `HAJIMI_REMOTE_BIND=lan`：允许同一局域网里的手机访问
- `HAJIMI_REMOTE_TOKEN`：如果不配置，`hajimi remote` 会在启动时临时生成一个 token
- `HAJIMI_REMOTE_HOST`：默认可以留空，Hajimi 会自动探测局域网地址
- `HAJIMI_REMOTE_PUBLIC_URL`：给反代或公网暴露预留

## 停止

在运行 `hajimi remote` 的终端里按：

```text
Ctrl+C
```

remote 服务会安全退出，并停止当前远程任务。
