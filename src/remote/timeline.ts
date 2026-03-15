import { formatTodoBlock, normalizeTodoItems, summarizeTodoItems } from "../agent/todos.js";
import { tryParseJson } from "../utils/json.js";
import type { RemoteSharedFileSummary, RemoteTimelineItem, RemoteTimelineTodoItem } from "./types.js";

export function createRemoteTimelineItem(input: {
  id: string;
  kind: RemoteTimelineItem["kind"];
  text: string;
  createdAt: string;
  toolName?: string;
  state?: RemoteTimelineItem["state"];
  summary?: string;
  collapsed?: boolean;
  todoItems?: RemoteTimelineTodoItem[];
  file?: RemoteSharedFileSummary;
}): RemoteTimelineItem {
  return {
    id: input.id,
    kind: input.kind,
    text: input.text,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    state: input.state ?? "done",
    toolName: input.toolName,
    summary: input.summary,
    collapsed: input.collapsed,
    todoItems: input.todoItems,
    file: input.file,
  };
}

export function parseTodoToolOutput(raw: string): {
  items: RemoteTimelineTodoItem[];
  summary: string;
  details: string;
} | null {
  const parsed = tryParseJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("items" in parsed)) {
    return null;
  }

  try {
    const items = normalizeTodoItems((parsed as { items?: unknown }).items);
    return {
      items,
      summary: summarizeTodoItems(items),
      details: formatTodoBlock(items),
    };
  } catch {
    return null;
  }
}

export function parseSharedFileOutput(raw: string): RemoteSharedFileSummary | null {
  const parsed = tryParseJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const shareId = readString(parsed, "shareId");
  const fileName = readString(parsed, "fileName");
  const relativePath = readString(parsed, "relativePath");
  const downloadPath = readString(parsed, "downloadPath");
  const createdAt = readString(parsed, "createdAt");
  const size = typeof (parsed as { size?: unknown }).size === "number"
    ? Math.max(0, Math.trunc((parsed as { size: number }).size))
    : null;

  if (!shareId || !fileName || !relativePath || !downloadPath || !createdAt || size === null) {
    return null;
  }

  return {
    shareId,
    fileName,
    relativePath,
    size,
    createdAt,
    downloadPath,
  };
}

export function summarizeToolError(raw: string, toolName?: string): string {
  const parsed = tryParseJson(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) {
      return toolName ? `${toolName}: ${record.error.trim()}` : record.error.trim();
    }
  }

  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return toolName ? `${toolName}: failed` : "Tool failed.";
  }

  if (normalized.length <= 240) {
    return toolName ? `${toolName}: ${normalized}` : normalized;
  }

  const truncated = `${normalized.slice(0, 240)}...`;
  return toolName ? `${toolName}: ${truncated}` : truncated;
}

function readString(value: object, key: string): string | null {
  const record = value as Record<string, unknown>;
  return typeof record[key] === "string" ? record[key] : null;
}
