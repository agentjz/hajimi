import { ITEM_LABELS, formatBytes, formatClock } from "./constants.js";

export function buildMessageElement(item, options) {
  const wrapper = document.createElement("article");
  wrapper.className = `message message-${normalizeKind(item.kind)}${item.state === "streaming" ? " streaming" : ""}`;
  wrapper.dataset.itemId = item.id;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const meta = document.createElement("div");
  meta.className = "message-meta";

  const title = document.createElement("span");
  title.className = "message-title";
  title.textContent = buildMessageTitle(item);

  const time = document.createElement("time");
  time.dateTime = item.updatedAt || item.createdAt;
  time.textContent = formatClock(item.updatedAt || item.createdAt);

  meta.append(title, time);
  bubble.appendChild(meta);

  if (item.toolName) {
    const tag = document.createElement("div");
    tag.className = "tool-tag";
    tag.textContent = item.toolName;
    bubble.appendChild(tag);
  }

  if (item.summary) {
    const summary = document.createElement("p");
    summary.className = "message-summary";
    summary.textContent = item.summary;
    bubble.appendChild(summary);
  }

  appendMessageBody(bubble, item, options);
  wrapper.appendChild(bubble);
  return wrapper;
}

function normalizeKind(kind) {
  switch (kind) {
    case "assistant":
      return "final_answer";
    case "tool_call":
      return "tool_use";
    case "tool_error":
      return "error";
    default:
      return kind || "status";
  }
}

function buildMessageTitle(item) {
  const kind = normalizeKind(item.kind);
  return ITEM_LABELS[kind] || "消息";
}

function appendMessageBody(container, item, options) {
  const kind = normalizeKind(item.kind);
  const text = typeof item.text === "string" ? item.text : "";

  if (kind === "tool_use") {
    const body = document.createElement("p");
    body.className = "message-text muted-text";
    body.textContent = item.state === "error" ? "这一步处理失败了。" : item.state === "streaming" ? "正在处理中..." : "这一步已经处理好了。";
    container.appendChild(body);
    return;
  }

  if (kind === "todo") {
    container.appendChild(buildTodoCard(item, options));
    return;
  }

  if (kind === "file_share") {
    container.appendChild(buildFileShareCard(item, options));
    return;
  }

  const useMonospace = kind === "reasoning";
  const isCollapsedByDefault = Boolean(item.collapsed);
  const collapseLimit = kind === "reasoning" ? 520 : 1200;

  if (!text.trim()) {
    const placeholder = document.createElement("p");
    placeholder.className = "message-text muted-text";
    placeholder.textContent = kind === "reasoning" ? "这一步还没有可显示的内容。" : "还在继续补充内容。";
    container.appendChild(placeholder);
    return;
  }

  if (isCollapsedByDefault || text.length > collapseLimit) {
    container.appendChild(buildCollapsibleText(item, text, useMonospace, collapseLimit, options));
    return;
  }

  const body = buildTextNode(text, useMonospace);
  container.appendChild(body);
}

function buildCollapsibleText(item, text, useMonospace, previewLength, options) {
  const wrapper = document.createElement("div");
  wrapper.className = "collapsible";

  const body = document.createElement("div");
  body.className = "collapsible-body";
  body.appendChild(buildTextNode(text, useMonospace));

  const isOpen = options.expandedItems.has(item.id) || (!item.collapsed && text.length <= previewLength);
  const previewText = text.length > previewLength
    ? `${text.slice(0, previewLength).trimEnd()}\n...`
    : "点击展开查看详情";

  const preview = buildTextNode(previewText, useMonospace);
  preview.classList.add("collapsible-preview");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "collapsible-button";

  applyCollapsibleState(options.expandedItems, item.id, preview, body, button, isOpen);
  button.addEventListener("click", () => {
    const nextOpen = !options.expandedItems.has(item.id);
    applyCollapsibleState(options.expandedItems, item.id, preview, body, button, nextOpen);
    if (nextOpen) {
      options.onExpand?.();
    }
  });

  wrapper.append(preview, button, body);
  return wrapper;
}

function buildTodoCard(item, options) {
  const wrapper = document.createElement("div");
  wrapper.className = "todo-card";

  const counts = document.createElement("div");
  counts.className = "todo-summary-row";
  counts.textContent = item.summary || "待办有更新";
  wrapper.appendChild(counts);

  const list = document.createElement("ul");
  list.className = "todo-list";
  const todos = Array.isArray(item.todoItems) ? item.todoItems : [];

  for (const todo of todos) {
    const row = document.createElement("li");
    row.className = `todo-item todo-${todo.status}`;

    const badge = document.createElement("span");
    badge.className = "todo-badge";
    badge.textContent = todo.status === "completed" ? "完成" : todo.status === "in_progress" ? "进行中" : "待办";

    const text = document.createElement("span");
    text.className = "todo-text";
    text.textContent = `#${todo.id} ${todo.text}`;

    row.append(badge, text);
    list.appendChild(row);
  }

  const preview = document.createElement("p");
  preview.className = "message-text muted-text";
  preview.textContent = "点展开查看这次待办更新。";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "collapsible-button";

  const isOpen = options.expandedItems.has(item.id);
  applyCollapsibleState(options.expandedItems, item.id, preview, list, button, isOpen);
  button.addEventListener("click", () => {
    const nextOpen = !options.expandedItems.has(item.id);
    applyCollapsibleState(options.expandedItems, item.id, preview, list, button, nextOpen);
  });

  wrapper.append(preview, button, list);
  return wrapper;
}

function buildFileShareCard(item, options) {
  const wrapper = document.createElement("div");
  wrapper.className = "file-card";

  const file = item.file || {};
  const rows = [
    ["文件名", file.fileName || "未知文件"],
    ["相对路径", file.relativePath || "-"],
    ["大小", formatBytes(file.size || 0)],
  ];

  for (const [labelText, valueText] of rows) {
    const row = document.createElement("div");
    row.className = "file-row";

    const label = document.createElement("span");
    label.className = "file-label";
    label.textContent = labelText;

    const value = document.createElement("span");
    value.className = "file-value";
    value.textContent = valueText;

    row.append(label, value);
    wrapper.appendChild(row);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "download-button";
  button.textContent = "下载文件";
  button.addEventListener("click", () => {
    options.onDownloadFile?.(item, button);
  });

  wrapper.appendChild(button);
  return wrapper;
}

function buildTextNode(text, useMonospace) {
  const node = document.createElement(useMonospace ? "pre" : "p");
  node.className = useMonospace ? "message-pre" : "message-text";
  node.textContent = text;
  return node;
}

function applyCollapsibleState(expandedItems, itemId, previewNode, bodyNode, buttonNode, isOpen) {
  if (isOpen) {
    expandedItems.add(itemId);
  } else {
    expandedItems.delete(itemId);
  }

  previewNode.classList.toggle("hidden", isOpen);
  bodyNode.classList.toggle("hidden", !isOpen);
  buttonNode.textContent = isOpen ? "收起" : "展开";
}
