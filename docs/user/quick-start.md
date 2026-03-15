# 快速开始

## 安装

```powershell
npm install
npm run build
```

## 配置

项目根目录放一个 `.env`：

```text
HAJIMI_API_KEY=replace-with-your-key
HAJIMI_BASE_URL=https://api.siliconflow.cn/v1
HAJIMI_MODEL=deepseek-ai/DeepSeek-V3.2
```

## 运行

```powershell
node dist/cli.js
node dist/cli.js "帮我看看这个项目"
```

## 自检

```powershell
node dist/cli.js doctor
npm test
```
