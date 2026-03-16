import { ITEM_LABELS, formatClock } from "./constants.js";
import { buildMarkdownNode } from "./markdown.js";

export function buildMessageElement(item, options) {
  const wrapper = document.createElement("article");
  wrapper.className = `message message-${item.kind}${item.state === "streaming" ? " streaming" : ""}`;
  wrapper.dataset.itemId = item.id;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const meta = document.createElement("div");
  meta.className = "message-meta";

  const title = document.createElement("span");
  title.className = "message-title";
  title.textContent = ITEM_LABELS[item.kind] || "消息";

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

function appendMessageBody(container, item, options) {
  const text = typeof item.text === "string" ? item.text : "";

  if (item.kind === "tool_use") {
    const body = document.createElement("p");
    body.className = "message-text muted-text";
    body.textContent = item.state === "error"
      ? "这个工具步骤执行失败。"
      : item.state === "streaming"
        ? "这个工具步骤正在执行。"
        : "这个工具步骤已经完成。";
    container.appendChild(body);
    return;
  }

  const useMonospace = item.kind === "reasoning";
  const renderMarkdown = item.kind === "user" || item.kind === "final_answer";
  const collapseLimit = item.kind === "reasoning" ? 520 : 1200;

  if (!text.trim()) {
    const placeholder = document.createElement("p");
    placeholder.className = "message-text muted-text";
    placeholder.textContent = item.kind === "reasoning"
      ? "这里暂时没有可显示的思考内容。"
      : "这里暂时没有可显示的内容。";
    container.appendChild(placeholder);
    return;
  }

  if (item.collapsed || text.length > collapseLimit) {
    container.appendChild(buildCollapsibleText(item, text, useMonospace, renderMarkdown, collapseLimit, options));
    return;
  }

  container.appendChild(buildBodyNode(text, useMonospace, renderMarkdown));
}

function buildCollapsibleText(item, text, useMonospace, renderMarkdown, previewLength, options) {
  const wrapper = document.createElement("div");
  wrapper.className = "collapsible";

  const body = document.createElement("div");
  body.className = "collapsible-body";
  body.appendChild(buildBodyNode(text, useMonospace, renderMarkdown));

  const isOpen = options.expandedItems.has(item.id) || (!item.collapsed && text.length <= previewLength);
  const previewText = text.length > previewLength
    ? `${text.slice(0, previewLength).trimEnd()}\n...`
    : "点击展开查看详情";

  const preview = buildPlainTextNode(previewText, useMonospace);
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

function buildBodyNode(text, useMonospace, renderMarkdown) {
  if (renderMarkdown && !useMonospace) {
    return buildMarkdownNode(text);
  }

  return buildPlainTextNode(text, useMonospace);
}

function buildPlainTextNode(text, useMonospace) {
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
