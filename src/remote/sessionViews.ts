import { isInternalMessage } from "../agent/taskState.js";
import type { SessionRecord, StoredMessage } from "../types.js";
import { tryParseJson } from "../utils/json.js";
import { createRemoteTimelineItem, summarizeToolError } from "./timeline.js";
import type { RemoteSessionDetails, RemoteTimelineItem } from "./types.js";

const MAX_REMOTE_MESSAGES = 40;
const MAX_REMOTE_MESSAGE_CHARS = 12_000;
const MAX_REMOTE_TIMELINE_ITEMS = 120;

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
            summary: "已完成",
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
