export const TOKEN_KEY = "hajimi_remote_token";

export const STATUS_LABELS = {
  idle: "空闲",
  running: "回复中",
  completed: "已回复",
  failed: "失败",
  cancelled: "已停止",
};

export const CONNECTION_LABELS = {
  idle: "未连接",
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
};

export const ITEM_LABELS = {
  user: "你",
  reasoning: "整理中",
  tool_use: "处理中",
  todo: "待办更新",
  final_answer: "哈基米",
  file_share: "发来一个文件",
  status: "提示",
  warning: "提醒",
  error: "出了点问题",
  assistant: "哈基米",
  tool_call: "处理中",
  tool_result: "处理结果",
  tool_error: "处理出错",
};

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
});

export function formatClock(value) {
  if (!value) {
    return "--:--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return timeFormatter.format(date);
}

export function formatBytes(size) {
  const value = Number(size) || 0;
  if (value < 1024) {
    return value + " B";
  }

  if (value < 1024 * 1024) {
    return (value / 1024).toFixed(1) + " KB";
  }

  return (value / (1024 * 1024)).toFixed(1) + " MB";
}
