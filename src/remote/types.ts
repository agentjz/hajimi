import type { StoredMessage } from "../types.js";

export type RemoteRunStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RemoteTimelineItemKind =
  | "user"
  | "reasoning"
  | "tool_use"
  | "final_answer"
  | "status"
  | "warning"
  | "error";

export type RemoteTimelineItemState = "streaming" | "done" | "error";

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
  timeline: RemoteTimelineItem[];
}

export interface RemoteSubmitPromptOptions {
  startNewConversation?: boolean;
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
  lastSession: RemoteSessionDetails | null;
}

export type RemoteStreamEventPayload =
  | { type: "snapshot"; state: RemoteStateSnapshot }
  | { type: "run"; run: RemoteRunSnapshot | null }
  | { type: "timeline_add"; sessionId: string; item: RemoteTimelineItem }
  | { type: "timeline_update"; sessionId: string; item: RemoteTimelineItem }
  | { type: "session"; lastSession: RemoteSessionDetails | null };

export interface RemoteStreamEvent {
  id: number;
  sentAt: string;
  payload: RemoteStreamEventPayload;
}

export type RemoteStreamListener = (event: RemoteStreamEvent) => void;

export interface RemoteControlProtocol {
  getState(): Promise<RemoteStateSnapshot>;
  submitPrompt(prompt: string, options?: RemoteSubmitPromptOptions): Promise<RemoteRunSnapshot>;
  cancelCurrentRun(): Promise<RemoteRunSnapshot | null>;
  subscribe(listener: RemoteStreamListener): () => void;
  stop(): Promise<void>;
}
