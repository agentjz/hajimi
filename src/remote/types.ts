import type { SessionRecord, StoredMessage } from "../types.js";

export type RemoteRunStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RemoteEventKind =
  | "status"
  | "tool_call"
  | "tool_result"
  | "tool_error"
  | "todo"
  | "file_share"
  | "final_answer"
  | "warning"
  | "error";

export interface RemoteRunEvent {
  kind: RemoteEventKind;
  text: string;
  createdAt: string;
}

export type RemoteTimelineItemKind =
  | "user"
  | "reasoning"
  | "tool_use"
  | "todo"
  | "final_answer"
  | "file_share"
  | "status"
  | "warning"
  | "error"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "tool_error";

export type RemoteTimelineItemState = "streaming" | "done" | "error";

export interface RemoteTimelineTodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface RemoteSharedFileSummary {
  shareId: string;
  fileName: string;
  relativePath: string;
  size: number;
  createdAt: string;
  downloadPath: string;
}

export interface RemoteTimelineItem {
  id: string;
  kind: RemoteTimelineItemKind;
  text: string;
  createdAt: string;
  updatedAt: string;
  state: RemoteTimelineItemState;
  toolName?: string;
  summary?: string;
  collapsed?: boolean;
  todoItems?: RemoteTimelineTodoItem[];
  file?: RemoteSharedFileSummary;
}

export interface RemoteRunSnapshot {
  sessionId: string;
  prompt: string;
  status: RemoteRunStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
  statusText?: string;
  assistantPreview?: string;
  reasoningPreview?: string;
  events: RemoteRunEvent[];
  timeline: RemoteTimelineItem[];
}

export interface RemoteSubmitPromptOptions {
  startNewConversation?: boolean;
}

export interface RemoteSessionSummary {
  id: string;
  title?: string;
  updatedAt: string;
  messageCount: number;
}

export interface RemoteSessionDetails {
  id: string;
  title?: string;
  updatedAt: string;
  messageCount: number;
  messages: StoredMessage[];
  timeline: RemoteTimelineItem[];
}

export interface RemoteStateSnapshot {
  streamCursor: number;
  projectCwd: string;
  currentRun: RemoteRunSnapshot | null;
  recentSessions: RemoteSessionSummary[];
  lastSession: RemoteSessionDetails | null;
}

export type RemoteStreamEventPayload =
  | { type: "snapshot"; state: RemoteStateSnapshot }
  | { type: "run"; run: RemoteRunSnapshot | null }
  | { type: "timeline_add"; sessionId: string; item: RemoteTimelineItem }
  | { type: "timeline_update"; sessionId: string; item: RemoteTimelineItem }
  | {
      type: "session";
      recentSessions: RemoteSessionSummary[];
      lastSession: RemoteSessionDetails | null;
    };

export interface RemoteStreamEvent {
  id: number;
  sentAt: string;
  payload: RemoteStreamEventPayload;
}

export type RemoteStreamListener = (event: RemoteStreamEvent) => void;

export interface RemoteSharedFileDownload {
  fileName: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface RemoteControlProtocol {
  getState(): Promise<RemoteStateSnapshot>;
  submitPrompt(prompt: string, options?: RemoteSubmitPromptOptions): Promise<RemoteRunSnapshot>;
  cancelCurrentRun(): Promise<RemoteRunSnapshot | null>;
  getSessionDetails(sessionId: string): Promise<RemoteSessionDetails | null>;
  getSharedFile(shareId: string): Promise<RemoteSharedFileDownload | null>;
  subscribe(listener: RemoteStreamListener): () => void;
  stop(): Promise<void>;
}

export interface RemoteTurnRunnerResult {
  session: SessionRecord;
}
