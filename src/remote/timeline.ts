import { tryParseJson } from "../utils/json.js";
import type { RemoteTimelineItem } from "./types.js";

export function createRemoteTimelineItem(input: {
  id: string;
  kind: RemoteTimelineItem["kind"];
  text: string;
  createdAt: string;
  toolName?: string;
  state?: RemoteTimelineItem["state"];
  summary?: string;
  collapsed?: boolean;
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
