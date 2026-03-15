import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import {
  expandStartToToolBoundary,
  isAssistantMessageInLatestTurn,
  shouldIncludeStoredAssistantReasoning,
  toChatMessage,
} from "./messages.js";
import type { RuntimeConfig, StoredMessage } from "../types.js";

const MIN_TAIL_MESSAGES = 8;
const DETAILED_RECENT_MESSAGES = 8;
const MAX_SUMMARY_MESSAGE_COUNT = 48;

export interface BuiltRequestContext {
  messages: ChatCompletionMessageParam[];
  compressed: boolean;
  estimatedChars: number;
  summary?: string;
}

export function buildRequestContext(
  systemPrompt: string,
  messages: StoredMessage[],
  config: Pick<
    RuntimeConfig,
    "contextWindowMessages" | "model" | "maxContextChars" | "contextSummaryChars"
  >,
): BuiltRequestContext {
  const safeMaxChars = Math.max(8_000, config.maxContextChars);
  let tailCount = Math.max(1, Math.min(messages.length, config.contextWindowMessages));

  while (true) {
    const tailMessages = sliceTailMessages(messages, tailCount);
    const olderMessages = messages.slice(0, Math.max(0, messages.length - tailMessages.length));
    const summary =
      olderMessages.length > 0
        ? summarizeConversation(olderMessages, config.contextSummaryChars)
        : undefined;
    const summaryPrompt = appendSummary(systemPrompt, summary);

    let workingTail = compactTailMessages(tailMessages, false);
    let requestMessages = composeChatMessages(summaryPrompt, workingTail, config.model);
    let estimatedChars = estimateChatMessagesChars(requestMessages);

    if (estimatedChars <= safeMaxChars) {
      return {
        messages: requestMessages,
        compressed: Boolean(summary),
        estimatedChars,
        summary,
      };
    }

    workingTail = compactTailMessages(tailMessages, true);
    requestMessages = composeChatMessages(summaryPrompt, workingTail, config.model);
    estimatedChars = estimateChatMessagesChars(requestMessages);

    if (estimatedChars <= safeMaxChars) {
      return {
        messages: requestMessages,
        compressed: true,
        estimatedChars,
        summary,
      };
    }

    if (tailCount > MIN_TAIL_MESSAGES) {
      tailCount = Math.max(MIN_TAIL_MESSAGES, tailCount - 4);
      continue;
    }

    const fallbackSummary = summary
      ? truncate(summary, Math.max(1_200, Math.floor(config.contextSummaryChars * 0.6)))
      : undefined;
    const fallbackTail = sliceTailMessages(messages, MIN_TAIL_MESSAGES);
    const fallbackMessages = composeChatMessages(
      appendSummary(systemPrompt, fallbackSummary),
      compactTailMessages(fallbackTail, true),
      config.model,
    );

    return {
      messages: fallbackMessages,
      compressed: true,
      estimatedChars: estimateChatMessagesChars(fallbackMessages),
      summary: fallbackSummary,
    };
  }
}

function sliceTailMessages(messages: StoredMessage[], tailCount: number): StoredMessage[] {
  if (messages.length === 0) {
    return [];
  }

  const startIndex = Math.max(0, messages.length - tailCount);
  const safeStartIndex = expandStartToToolBoundary(messages, startIndex);
  return messages.slice(safeStartIndex);
}

function composeChatMessages(
  systemPrompt: string,
  messages: StoredMessage[],
  model: string,
): ChatCompletionMessageParam[] {
  return [
    {
      role: "system",
      content: systemPrompt,
    },
    ...messages.map((message, index) =>
      toChatMessage(message, {
        includeReasoning: shouldIncludeStoredAssistantReasoning(messages, index, model),
      }),
    ),
  ];
}

function compactTailMessages(messages: StoredMessage[], aggressive: boolean): StoredMessage[] {
  const protectedStart = Math.max(0, messages.length - DETAILED_RECENT_MESSAGES);

  return messages.map((message, index) => {
    if (index >= protectedStart) {
      return message;
    }

    if (message.role === "tool") {
      return {
        ...message,
        content: compactToolPayload(message.name, message.content ?? "", aggressive ? 320 : 700),
      };
    }

    if (message.role === "assistant") {
      return {
        ...message,
        content: truncate(message.content ?? "", aggressive ? 300 : 700),
        reasoningContent: isAssistantMessageInLatestTurn(messages, index)
          ? message.reasoningContent
          : undefined,
      };
    }

    if (message.role === "user") {
      return {
        ...message,
        content: truncate(message.content ?? "", aggressive ? 320 : 800),
      };
    }

    return message;
  });
}

function summarizeConversation(messages: StoredMessage[], maxChars: number): string {
  const summaryLines: string[] = [];
  const candidates = pickSummaryCandidates(messages);
  let totalChars = 0;

  for (const message of candidates) {
    const line = summarizeStoredMessage(message);
    if (!line) {
      continue;
    }

    const nextLine = `- ${line}`;
    if (summaryLines.includes(nextLine)) {
      continue;
    }

    const nextChars = totalChars + nextLine.length + 1;
    if (nextChars > maxChars) {
      break;
    }

    summaryLines.push(nextLine);
    totalChars = nextChars;
  }

  if (summaryLines.length === 0) {
    return "No earlier context summary was available.";
  }

  return summaryLines.join("\n");
}

function pickSummaryCandidates(messages: StoredMessage[]): StoredMessage[] {
  const firstUser = messages.find((message) => message.role === "user");
  const recent = messages.slice(-MAX_SUMMARY_MESSAGE_COUNT);

  if (!firstUser) {
    return recent;
  }

  return [firstUser, ...recent.filter((message) => message !== firstUser)];
}

function summarizeStoredMessage(message: StoredMessage): string {
  if (message.role === "user") {
    return `User asked: ${truncate(oneLine(message.content ?? ""), 240)}`;
  }

  if (message.role === "assistant" && message.tool_calls?.length) {
    const names = message.tool_calls.map((toolCall) => toolCall.function.name).join(", ");
    const content = truncate(oneLine(message.content ?? ""), 140);
    return content
      ? `Assistant planned tools (${names}) and said: ${content}`
      : `Assistant planned tools: ${names}`;
  }

  if (message.role === "assistant") {
    return `Assistant said: ${truncate(oneLine(message.content ?? ""), 220)}`;
  }

  if (message.role === "tool") {
    return `Tool ${message.name ?? "unknown"} returned: ${compactToolPayload(
      message.name,
      message.content ?? "",
      220,
    )}`;
  }

  return "";
}

function compactToolPayload(toolName: string | undefined, raw: string, maxChars: number): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fragments: string[] = [];

    pushFragment(fragments, "ok", readScalar(parsed.ok));
    pushFragment(fragments, "path", readScalar(parsed.path));
    pushFragment(fragments, "requestedPath", readScalar(parsed.requestedPath));
    pushFragment(fragments, "format", readScalar(parsed.format));
    pushFragment(fragments, "title", readScalar(parsed.title));
    pushFragment(fragments, "readable", readScalar(parsed.readable));
    pushFragment(fragments, "reason", readScalar(parsed.reason));
    pushFragment(fragments, "action", readScalar(parsed.action));
    pushFragment(fragments, "suggestedTool", readScalar(parsed.suggestedTool));
    pushFragment(fragments, "suggestedPath", readScalar(parsed.suggestedPath));
    pushFragment(fragments, "code", readScalar(parsed.code));
    pushFragment(fragments, "error", readScalar(parsed.error));
    pushFragment(fragments, "hint", readScalar(parsed.hint));
    pushFragment(fragments, "next_step", readScalar(parsed.next_step));
    pushFragment(fragments, "entries", readCollectionCount(parsed.entries));
    pushFragment(fragments, "matches", readCollectionCount(parsed.matches));
    pushFragment(fragments, "sheets", readCollectionCount(parsed.sheets));
    pushFragment(fragments, "searched", readScalar(parsed.searched));
    pushFragment(fragments, "total", readScalar(parsed.total));
    pushFragment(fragments, "bytes", readScalar(parsed.bytes));
    pushFragment(fragments, "changeId", readScalar(parsed.changeId));
    pushFragment(fragments, "undoneChangeId", readScalar(parsed.undoneChangeId));
    pushFragment(fragments, "changeHistoryWarning", readScalar(parsed.changeHistoryWarning));
    pushFragment(fragments, "exitCode", readScalar(parsed.exitCode));
    pushFragment(fragments, "jobId", readScalar(parsed.jobId));
    pushFragment(fragments, "jobStatus", readScalar(parsed.jobStatus));
    pushFragment(fragments, "taskId", readScalar(parsed.taskId));
    pushFragment(fragments, "task", readScalar(parsed.task));
    pushFragment(fragments, "member", readScalar(parsed.member));
    pushFragment(fragments, "worktree", readScalar(parsed.worktree));
    pushFragment(fragments, "tasks", readCollectionCount(parsed.tasks));
    pushFragment(fragments, "members", readCollectionCount(parsed.members));
    pushFragment(fragments, "messages", readCollectionCount(parsed.messages));
    pushFragment(fragments, "jobs", readCollectionCount(parsed.jobs));
    pushFragment(fragments, "events", readCollectionCount(parsed.events));
    pushFragment(fragments, "worktrees", readCollectionCount(parsed.worktrees));
    pushFragment(fragments, "preview", truncate(oneLine(readScalar(parsed.preview) ?? ""), 120));
    pushFragment(fragments, "content", truncate(oneLine(readScalar(parsed.content) ?? ""), 120));
    pushFragment(fragments, "restoredPaths", readCollectionCount(parsed.restoredPaths));

    const summary = fragments.filter(Boolean).join("; ");
    if (summary.length > 0) {
      return truncate(summary, maxChars);
    }
  } catch {
    if (toolName && raw.trim().startsWith("[")) {
      return truncate(`${toolName} returned structured array data`, maxChars);
    }
  }

  return truncate(oneLine(raw), maxChars);
}

function estimateChatMessagesChars(messages: ChatCompletionMessageParam[]): number {
  return messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
}

function appendSummary(systemPrompt: string, summary: string | undefined): string {
  if (!summary) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\nCompressed conversation memory:\n${summary}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...`;
}

function readScalar(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

function readCollectionCount(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return String(value.length);
}

function pushFragment(fragments: string[], key: string, value: string | undefined): void {
  if (!value) {
    return;
  }

  fragments.push(`${key}=${value}`);
}
