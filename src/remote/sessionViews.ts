import { isInternalMessage } from "../agent/taskState.js";
import type { RemoteSessionDetails, RemoteSessionSummary, RemoteTimelineItem } from "./types.js";
import type { SessionRecord, StoredMessage } from "../types.js";
import { tryParseJson } from "../utils/json.js";
import { createRemoteTimelineItem, parseSharedFileOutput, parseTodoToolOutput, summarizeToolError } from "./timeline.js";

const MAX_REMOTE_MESSAGES = 40;
const MAX_REMOTE_MESSAGE_CHARS = 12_000;
const MAX_REMOTE_TIMELINE_ITEMS = 120;

export function toRemoteSessionSummary(session: SessionRecord): RemoteSessionSummary {
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
  };
}

export function toRemoteSessionDetails(session: SessionRecord): RemoteSessionDetails {
  const messages = session.messages.slice(-MAX_REMOTE_MESSAGES).map(serializeMessage);
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    messages,
    timeline: toRemoteTimeline(session.id, messages),
  };
}

function serializeMessage(message: StoredMessage): StoredMessage {
  return {
    ...message,
    content: truncateNullableText(message.content),
    reasoningContent: truncateOptionalText(message.reasoningContent),
  };
}

function truncateNullableText(value: string | null): string | null {
  if (typeof value !== "string" || value.length <= MAX_REMOTE_MESSAGE_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_REMOTE_MESSAGE_CHARS)}\n\n... [truncated for remote view]`;
}

function truncateOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length <= MAX_REMOTE_MESSAGE_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_REMOTE_MESSAGE_CHARS)}\n\n... [truncated for remote view]`;
}

function toRemoteTimeline(sessionId: string, messages: StoredMessage[]): RemoteTimelineItem[] {
  const timeline: RemoteTimelineItem[] = [];

  for (const [index, message] of messages.entries()) {
    appendMessageTimelineItems(timeline, sessionId, index, message);
  }

  return timeline.slice(-MAX_REMOTE_TIMELINE_ITEMS);
}

function appendMessageTimelineItems(
  timeline: RemoteTimelineItem[],
  sessionId: string,
  index: number,
  message: StoredMessage,
): void {
  const createdAt = message.createdAt;
  const baseId = `${sessionId}-${index}`;

  if (message.role === "user") {
    if (!message.content || isInternalMessage(message.content)) {
      return;
    }

    timeline.push(
      createRemoteTimelineItem({
        id: `${baseId}-user`,
        kind: "user",
        text: message.content,
        createdAt,
      }),
    );
    return;
  }

  if (message.role === "assistant") {
    if (message.reasoningContent) {
      timeline.push(
        createRemoteTimelineItem({
          id: `${baseId}-reasoning`,
          kind: "reasoning",
          text: message.reasoningContent,
          createdAt,
          collapsed: true,
        }),
      );
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      for (const [toolIndex, toolCall] of message.tool_calls.entries()) {
        timeline.push(
          createRemoteTimelineItem({
            id: `${baseId}-tool-use-${toolIndex}`,
            kind: "tool_use",
            toolName: toolCall.function.name,
            text: "",
            createdAt,
            summary: "已执行",
            collapsed: true,
          }),
        );
      }
    }

    if (message.content) {
      timeline.push(
        createRemoteTimelineItem({
          id: `${baseId}-final-answer`,
          kind: "final_answer",
          text: message.content,
          createdAt,
        }),
      );
    }
    return;
  }

  if (message.role !== "tool") {
    return;
  }

  if (message.name === "todo_write") {
    const todo = parseTodoToolOutput(message.content ?? "");
    if (todo) {
      timeline.push(
        createRemoteTimelineItem({
          id: `${baseId}-todo`,
          kind: "todo",
          text: todo.details,
          createdAt,
          summary: todo.summary,
          collapsed: true,
          todoItems: todo.items,
        }),
      );
    }
    return;
  }

  if (message.name === "remote_share_file") {
    const sharedFile = parseSharedFileOutput(message.content ?? "");
    if (sharedFile) {
      timeline.push(
        createRemoteTimelineItem({
          id: `${baseId}-file-share`,
          kind: "file_share",
          text: "文件已准备好，点下载即可获取分享时刻的快照。",
          createdAt,
          summary: "文件已准备好",
          file: sharedFile,
        }),
      );
    }
    return;
  }

  if (isToolErrorMessage(message.content ?? "")) {
    timeline.push(
      createRemoteTimelineItem({
        id: `${baseId}-tool-error`,
        kind: "error",
        text: summarizeToolError(message.content ?? "", message.name),
        createdAt,
        state: "error",
      }),
    );
  }
}

function isToolErrorMessage(content: string): boolean {
  const parsed = tryParseJson(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }

  const record = parsed as Record<string, unknown>;
  return record.ok === false || typeof record.error === "string";
}
