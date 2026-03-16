# 远程模式

## 适用场景

`hajimi remote` 适合这种用法：

- 电脑上正在跑 Hajimi
- 手机和电脑在同一个局域网里
- 你想在手机上像聊天一样发任务、看思考过程、看工具使用、必要时停止当前任务

它不是远程终端，也不是把电脑屏幕投到手机上，而是一个手机优先的远程聊天控制页。

## 启动

```powershell
hajimi remote
```

终端会输出：

- 手机访问地址

现在打开这个地址就能直接进入聊天页，不需要 token。

## 手机页面现在会显示什么

新版 remote 页面只保留聊天核心：

- 顶部显示当前工作目录
- 顶部有一个 `新建对话` 按钮
- 一开始是空对话
- 你发出消息后，页面会按顺序显示：
  - 你的消息
  - 思考过程
  - 工具使用
  - 最终答案
- 当前任务运行中可以点击 `停止`
- 任务完成、停止、失败时会显示简洁状态卡片

remote 不再包含：

- 访问令牌输入页
- 文件分享
- 文件下载
- 自动生成下载卡片

## 对话怎么继续

- 不点 `新建对话` 时，下一条消息会继续当前对话
- 点 `新建对话` 后，会回到空白对话，从头开始

## 可选配置

可以在项目里的 `.hajimi/.env` 放这些配置：

```text
HAJIMI_REMOTE_ENABLED=true
HAJIMI_REMOTE_BIND=lan
HAJIMI_REMOTE_PORT=4387
# HAJIMI_REMOTE_HOST=
# HAJIMI_REMOTE_PUBLIC_URL=
```

说明：

- `HAJIMI_REMOTE_BIND=lan`：允许同一局域网里的手机访问
- `HAJIMI_REMOTE_HOST`：默认可以留空，Hajimi 会自动探测局域网地址
- `HAJIMI_REMOTE_PUBLIC_URL`：给反代或公网暴露预留

## 停止

在运行 `hajimi remote` 的终端里按：

```text
Ctrl+C
```

remote 服务会安全退出，并停止当前远程任务。
