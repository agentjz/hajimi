export const STATUS_LABELS = {
  idle: "空闲",
  running: "回复中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
};

export const CONNECTION_LABELS = {
  idle: "未连接",
  connecting: "连接中",
  connected: "哈基米已连接",
  reconnecting: "重连中",
};

export const ITEM_LABELS = {
  user: "你",
  reasoning: "思考过程",
  tool_use: "工具使用",
  final_answer: "哈基米",
  status: "状态",
  warning: "提醒",
  error: "出错了",
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
