import path from "node:path";

import { runManagedAgentTurn } from "../agent/managedTurn.js";
import { AgentTurnError, getErrorMessage } from "../agent/errors.js";
import { SessionStore } from "../agent/sessionStore.js";
import type { AgentCallbacks } from "../agent/types.js";
import { createRemoteShareFileTool, createRuntimeToolRegistry } from "../tools/index.js";
import type { ToolRegistry } from "../tools/index.js";
import type { RuntimeConfig, StoredMessage } from "../types.js";
import { isAbortError } from "../utils/abort.js";
import { resolveUserPath } from "../utils/fs.js";
import { RemoteFileShareStore } from "./fileShares.js";
import { createRemoteTimelineItem, parseSharedFileOutput, parseTodoToolOutput, summarizeToolError } from "./timeline.js";
import { toRemoteSessionDetails, toRemoteSessionSummary } from "./sessionViews.js";
import type {
  RemoteControlProtocol,
  RemoteRunEvent,
  RemoteRunSnapshot,
  RemoteSharedFileDownload,
  RemoteStateSnapshot,
  RemoteStreamEvent,
  RemoteStreamEventPayload,
  RemoteStreamListener,
  RemoteSubmitPromptOptions,
  RemoteTimelineItem,
  RemoteTimelineItemKind,
  RemoteTimelineItemState,
} from "./types.js";

const MAX_REMOTE_EVENTS = 80;
const MAX_REMOTE_PREVIEW_CHARS = 24_000;
const MAX_REMOTE_TIMELINE_ITEMS = 240;
const MAX_REMOTE_TIMELINE_TEXT_CHARS = 32_000;
const AUTO_SHARE_DOCUMENT_EXTENSIONS = new Set([
  ".csv",
  ".docx",
  ".htm",
  ".html",
  ".md",
  ".pdf",
  ".rtf",
  ".tsv",
  ".txt",
]);

export interface RemoteControlServiceOptions {
  cwd: string;
  config: RuntimeConfig;
  sessionStore: SessionStore;
  runTurn?: typeof runManagedAgentTurn;
}

interface ActiveRemoteRun {
  snapshot: RemoteRunSnapshot;
  controller: AbortController;
  promise: Promise<void>;
  itemCounter: number;
  pendingReasoningText: string;
  currentToolItemId: string | null;
  currentToolName: string | null;
  sharedSourcePaths: Set<string>;
}

export class RemoteControlService implements RemoteControlProtocol {
  private readonly runTurn: typeof runManagedAgentTurn;
  private readonly listeners = new Set<RemoteStreamListener>();
  private readonly shareStore: RemoteFileShareStore;
  private currentRun: ActiveRemoteRun | null = null;
  private lastSessionId: string | null = null;
  private streamCursor = 0;
  private toolRegistryPromise: Promise<ToolRegistry> | null = null;

  constructor(private readonly options: RemoteControlServiceOptions) {
    this.runTurn = options.runTurn ?? runManagedAgentTurn;
    this.shareStore = new RemoteFileShareStore(
      path.join(options.config.paths.cacheDir, "remote-file-shares"),
    );
  }

  async getState(): Promise<RemoteStateSnapshot> {
    const recentSessions = await this.listProjectSessions();
    const lastSessionId = this.currentRun?.snapshot.sessionId || this.lastSessionId || recentSessions[0]?.id || null;
    const lastSession = lastSessionId ? await this.getSessionDetails(lastSessionId) : null;

    return {
      streamCursor: this.streamCursor,
      projectCwd: this.options.cwd,
      currentRun: this.currentRun ? cloneSnapshot(this.currentRun.snapshot) : null,
      recentSessions,
      lastSession,
    };
  }

  subscribe(listener: RemoteStreamListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async submitPrompt(prompt: string, options: RemoteSubmitPromptOptions = {}): Promise<RemoteRunSnapshot> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      throw new Error("Prompt cannot be empty.");
    }

    if (this.currentRun?.snapshot.status === "running") {
      throw new Error("A remote task is already running. Stop it before starting another one.");
    }

    const prepared = await this.prepareSessionForPrompt(options);
    const session = prepared.session;
    const startedAt = new Date().toISOString();
    const snapshot: RemoteRunSnapshot = {
      sessionId: session.id,
      prompt: normalizedPrompt,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      events: [],
      timeline: prepared.timeline.map(cloneTimelineItem),
    };

    const run: ActiveRemoteRun = {
      snapshot,
      controller: new AbortController(),
      promise: Promise.resolve(),
      itemCounter: 0,
      pendingReasoningText: "",
      currentToolItemId: null,
      currentToolName: null,
      sharedSourcePaths: new Set(),
    };

    this.addTimelineItem(
      run,
      {
        kind: "user",
        text: normalizedPrompt,
        createdAt: startedAt,
      },
      { emit: false },
    );

    this.currentRun = run;
    this.lastSessionId = session.id;
    run.promise = this.runPrompt(run, session.id, normalizedPrompt);

    this.emit({
      type: "run",
      run: cloneSnapshot(snapshot),
    });
    void this.publishSessionSync();

    return cloneSnapshot(snapshot);
  }

  async cancelCurrentRun(): Promise<RemoteRunSnapshot | null> {
    if (!this.currentRun) {
      return null;
    }

    if (this.currentRun.snapshot.status !== "running") {
      return cloneSnapshot(this.currentRun.snapshot);
    }

    this.currentRun.controller.abort();
    await this.currentRun.promise.catch(() => undefined);
    return cloneSnapshot(this.currentRun.snapshot);
  }

  async getSessionDetails(sessionId: string) {
    try {
      const session = await this.options.sessionStore.load(sessionId);
      if (session.cwd !== this.options.cwd) {
        return null;
      }

      return toRemoteSessionDetails(session);
    } catch {
      return null;
    }
  }

  async getSharedFile(shareId: string): Promise<RemoteSharedFileDownload | null> {
    return this.shareStore.getSharedFile(shareId);
  }

  async stop(): Promise<void> {
    if (!this.currentRun) {
      return;
    }

    if (this.currentRun.snapshot.status === "running") {
      this.currentRun.controller.abort();
    }

    await this.currentRun.promise.catch(() => undefined);
  }

  private async prepareSessionForPrompt(options: RemoteSubmitPromptOptions = {}): Promise<{
    session: Awaited<ReturnType<SessionStore["save"]>>;
    timeline: RemoteTimelineItem[];
  }> {
    if (options.startNewConversation) {
      return this.createPreparedSession();
    }

    if (this.currentRun && this.currentRun.snapshot.status !== "running") {
      return this.loadPreparedSession(
        this.currentRun.snapshot.sessionId,
        this.currentRun.snapshot.timeline,
      );
    }

    const continuationSession = await this.loadContinuationSession();
    if (continuationSession) {
      return this.loadPreparedSession(continuationSession.id);
    }

    return this.createPreparedSession();
  }

  private async createPreparedSession(): Promise<{
    session: Awaited<ReturnType<SessionStore["save"]>>;
    timeline: RemoteTimelineItem[];
  }> {
    const createdSession = await this.options.sessionStore.create(this.options.cwd);
    const session = await this.options.sessionStore.save(createdSession);
    return {
      session,
      timeline: [],
    };
  }

  private async loadPreparedSession(
    sessionId: string,
    supplementalTimeline: RemoteTimelineItem[] = [],
  ): Promise<{
    session: Awaited<ReturnType<SessionStore["save"]>>;
    timeline: RemoteTimelineItem[];
  }> {
    const session = await this.options.sessionStore.load(sessionId);
    const details = toRemoteSessionDetails(session);
    return {
      session,
      timeline: mergeTimelineItems(details.timeline, supplementalTimeline),
    };
  }

  private async loadContinuationSession() {
    const preferredIds = [
      this.lastSessionId,
      this.currentRun?.snapshot.sessionId ?? null,
    ].filter((value): value is string => Boolean(value));

    for (const sessionId of preferredIds) {
      try {
        const session = await this.options.sessionStore.load(sessionId);
        if (session.cwd === this.options.cwd) {
          return session;
        }
      } catch {
        // ignore missing saved sessions and fall through to recents
      }
    }

    const sessions = await this.options.sessionStore.list(20);
    return sessions.find((session) => session.cwd === this.options.cwd) ?? null;
  }

  private async runPrompt(run: ActiveRemoteRun, sessionId: string, prompt: string): Promise<void> {
    const session = await this.options.sessionStore.load(sessionId);
    const toolRegistry = await this.getTurnToolRegistry();

    try {
      const result = await this.runTurn({
        input: prompt,
        cwd: this.options.cwd,
        config: this.options.config,
        session,
        sessionStore: this.options.sessionStore,
        toolRegistry,
        abortSignal: run.controller.signal,
        callbacks: this.createCallbacks(run),
        identity: {
          kind: "lead",
          name: "lead",
        },
      });

      const autoShareMessages = await this.createAutoShareMessages(run, result.changedPaths);
      let persistedSession = result.session;
      if (autoShareMessages.length > 0) {
        persistedSession = await this.options.sessionStore.appendMessages(result.session, autoShareMessages);
      }

      const updatedAt = this.touchRun(run);
      this.flushReasoningItem(run, updatedAt);
      this.finalizeCurrentToolItem(run, updatedAt, "done");
      run.snapshot.status = "completed";
      run.snapshot.updatedAt = updatedAt;
      run.snapshot.finishedAt = updatedAt;
      run.snapshot.statusText = "任务已完成";
      this.lastSessionId = persistedSession.id;

      pushEvent(run.snapshot, {
        kind: "status",
        text: "Remote task completed.",
        createdAt: updatedAt,
      });
      this.addTimelineItem(run, {
        kind: "status",
        text: "任务已完成，可以继续发送下一条消息。",
        createdAt: updatedAt,
      });
      this.emit({
        type: "run",
        run: cloneSnapshot(run.snapshot),
      });
    } catch (error) {
      const updatedAt = this.touchRun(run);
      this.flushReasoningItem(run, updatedAt);
      run.snapshot.updatedAt = updatedAt;
      run.snapshot.finishedAt = updatedAt;

      if (error instanceof AgentTurnError) {
        this.lastSessionId = error.session.id;
      }

      if (isAbortError(error)) {
        this.finalizeCurrentToolItem(run, updatedAt, "error");
        run.snapshot.status = "cancelled";
        run.snapshot.error = "Task cancelled by remote operator.";
        run.snapshot.statusText = "任务已停止";
        pushEvent(run.snapshot, {
          kind: "warning",
          text: run.snapshot.error,
          createdAt: updatedAt,
        });
        this.addTimelineItem(run, {
          kind: "warning",
          text: "任务已停止。",
          createdAt: updatedAt,
        });
        this.emit({
          type: "run",
          run: cloneSnapshot(run.snapshot),
        });
        await this.publishSessionSync();
        return;
      }

      this.finalizeCurrentToolItem(run, updatedAt, "error");
      run.snapshot.status = "failed";
      run.snapshot.error = getErrorMessage(error);
      run.snapshot.statusText = "任务失败";
      pushEvent(run.snapshot, {
        kind: "error",
        text: run.snapshot.error,
        createdAt: updatedAt,
      });
      this.addTimelineItem(run, {
        kind: "error",
        text: run.snapshot.error,
        createdAt: updatedAt,
        state: "error",
      });
      this.emit({
        type: "run",
        run: cloneSnapshot(run.snapshot),
      });
    }

    await this.publishSessionSync();
  }

  private async getTurnToolRegistry(): Promise<ToolRegistry> {
    if (!this.toolRegistryPromise) {
      this.toolRegistryPromise = createRuntimeToolRegistry(this.options.config, {
        includeTools: [createRemoteShareFileTool(this.shareStore)],
      });
    }

    return this.toolRegistryPromise;
  }

  private createCallbacks(run: ActiveRemoteRun): AgentCallbacks {
    return {
      onModelWaitStart: () => {
        run.pendingReasoningText = "";
      },
      onModelWaitStop: () => {
        this.flushReasoningItem(run, this.touchRun(run));
      },
      onStatus: (text) => {
        run.snapshot.statusText = text;
        this.touchRun(run);
        this.emit({
          type: "run",
          run: cloneSnapshot(run.snapshot),
        });
      },
      onAssistantDelta: (delta) => {
        run.snapshot.assistantPreview = appendPreview(run.snapshot.assistantPreview, delta);
        this.touchRun(run);
      },
      onAssistantText: (text) => {
        run.snapshot.assistantPreview = truncatePreview(text);
        this.touchRun(run);
      },
      onAssistantDone: (fullText) => {
        const now = this.touchRun(run);
        this.flushReasoningItem(run, now);
        run.snapshot.assistantPreview = truncatePreview(fullText);
        pushEvent(run.snapshot, {
          kind: "final_answer",
          text: truncateForEvent(fullText),
          createdAt: now,
        });
        this.addTimelineItem(run, {
          kind: "final_answer",
          text: truncateTimelineText(fullText),
          createdAt: now,
        });
      },
      onReasoningDelta: (delta) => {
        run.snapshot.reasoningPreview = appendPreview(run.snapshot.reasoningPreview, delta);
        if (this.options.config.showReasoning) {
          run.pendingReasoningText = appendTimelineText(
            run.pendingReasoningText,
            delta,
            MAX_REMOTE_TIMELINE_TEXT_CHARS,
          );
        }
        this.touchRun(run);
      },
      onReasoning: (text) => {
        const now = this.touchRun(run);
        run.snapshot.reasoningPreview = truncatePreview(text);
        if (!this.options.config.showReasoning) {
          run.pendingReasoningText = "";
          return;
        }

        run.pendingReasoningText = truncateTimelineText(text);
        this.flushReasoningItem(run, now);
      },
      onToolCall: (name) => {
        const now = this.touchRun(run);
        this.flushReasoningItem(run, now);
        this.finalizeCurrentToolItem(run, now, "done");

        pushEvent(run.snapshot, {
          kind: "tool_call",
          text: name,
          createdAt: now,
        });

        const item = this.addTimelineItem(run, {
          kind: "tool_use",
          text: "",
          createdAt: now,
          toolName: name,
          state: "streaming",
          summary: "执行中",
          collapsed: true,
        });
        run.currentToolItemId = item.id;
        run.currentToolName = name;
      },
      onToolResult: (name, output) => {
        const now = this.touchRun(run);
        this.finalizeCurrentToolItem(run, now, "done");
        pushEvent(run.snapshot, {
          kind: name === "todo_write" ? "todo" : name === "remote_share_file" ? "file_share" : "tool_result",
          text: name,
          createdAt: now,
        });

        if (name === "todo_write") {
          const todo = parseTodoToolOutput(output);
          if (todo) {
            this.addTimelineItem(run, {
              kind: "todo",
              text: truncateTimelineText(todo.details),
              createdAt: now,
              summary: todo.summary,
              collapsed: true,
              todoItems: todo.items,
            });
          }
          return;
        }

        if (name === "remote_share_file") {
          const sharedFile = parseSharedFileOutput(output);
          if (sharedFile) {
            this.trackSharedSourcePath(run, sharedFile.relativePath);
          }
          if (sharedFile) {
            this.addTimelineItem(run, {
              kind: "file_share",
              text: "文件已准备好，点下载即可获取当时分享的快照。",
              createdAt: now,
              summary: "文件已准备好",
              file: sharedFile,
            });
          }
        }
      },
      onToolError: (name, error) => {
        const now = this.touchRun(run);
        this.finalizeCurrentToolItem(run, now, "error");
        const summary = summarizeToolError(error, name);
        pushEvent(run.snapshot, {
          kind: "tool_error",
          text: summary,
          createdAt: now,
        });
        this.addTimelineItem(run, {
          kind: "error",
          text: summary,
          createdAt: now,
          state: "error",
        });
      },
    };
  }

  private async createAutoShareMessages(run: ActiveRemoteRun, changedPaths: string[]): Promise<StoredMessage[]> {
    const toolMessages: StoredMessage[] = [];

    for (const sourcePath of collectAutoShareCandidates(changedPaths, this.options.cwd)) {
      const normalizedSourcePath = path.normalize(sourcePath);
      if (run.sharedSourcePaths.has(normalizedSourcePath)) {
        continue;
      }

      try {
        const sharedFile = await this.shareStore.createShare({
          sourcePath: normalizedSourcePath,
          cwd: this.options.cwd,
        });
        const createdAt = this.touchRun(run);
        run.sharedSourcePaths.add(normalizedSourcePath);
        pushEvent(run.snapshot, {
          kind: "file_share",
          text: sharedFile.fileName,
          createdAt,
        });
        this.addSharedFileTimelineItem(run, sharedFile, createdAt);
        toolMessages.push({
          role: "tool",
          name: "remote_share_file",
          content: serializeSharedFileSummary(sharedFile),
          createdAt,
        });
      } catch (error) {
        const createdAt = this.touchRun(run);
        const message = `Failed to prepare ${path.basename(normalizedSourcePath)} for download: ${getErrorMessage(error)}`;
        pushEvent(run.snapshot, {
          kind: "warning",
          text: message,
          createdAt,
        });
        this.addTimelineItem(run, {
          kind: "warning",
          text: message,
          createdAt,
        });
      }
    }

    return toolMessages;
  }

  private trackSharedSourcePath(run: ActiveRemoteRun, relativePath: string): void {
    if (!relativePath.trim()) {
      return;
    }

    run.sharedSourcePaths.add(path.normalize(resolveUserPath(relativePath, this.options.cwd)));
  }

  private addSharedFileTimelineItem(
    run: ActiveRemoteRun,
    sharedFile: NonNullable<RemoteTimelineItem["file"]>,
    createdAt: string,
  ): void {
    this.addTimelineItem(run, {
      kind: "file_share",
      text: "File is ready to download from this remote session.",
      createdAt,
      summary: "File is ready",
      file: sharedFile,
    });
  }

  private flushReasoningItem(run: ActiveRemoteRun, createdAt: string): void {
    const reasoningText = run.pendingReasoningText.trim();
    run.pendingReasoningText = "";

    if (!reasoningText || !this.options.config.showReasoning) {
      return;
    }

    this.addTimelineItem(run, {
      kind: "reasoning",
      text: truncateTimelineText(reasoningText),
      createdAt,
      collapsed: true,
    });
  }

  private finalizeCurrentToolItem(
    run: ActiveRemoteRun,
    updatedAt: string,
    state: Extract<RemoteTimelineItemState, "done" | "error">,
  ): void {
    if (!run.currentToolItemId) {
      return;
    }

    this.updateTimelineItem(run, run.currentToolItemId, (item) => ({
      ...item,
      state,
      summary: state === "error" ? "执行失败" : "已完成",
      updatedAt,
    }));
    run.currentToolItemId = null;
    run.currentToolName = null;
  }

  private addTimelineItem(
    run: ActiveRemoteRun,
    input: {
      kind: RemoteTimelineItemKind;
      text: string;
      createdAt: string;
      toolName?: string;
      state?: RemoteTimelineItemState;
      summary?: string;
      collapsed?: boolean;
      todoItems?: RemoteTimelineItem["todoItems"];
      file?: RemoteTimelineItem["file"];
    },
    options: { emit?: boolean } = {},
  ): RemoteTimelineItem {
    const item = createRemoteTimelineItem({
      id: `${run.snapshot.sessionId}-item-${++run.itemCounter}`,
      kind: input.kind,
      text: truncateTimelineText(input.text),
      createdAt: input.createdAt,
      toolName: input.toolName,
      state: input.state ?? "done",
      summary: input.summary,
      collapsed: input.collapsed,
      todoItems: input.todoItems,
      file: input.file,
    });
    run.snapshot.timeline = [...run.snapshot.timeline, item].slice(-MAX_REMOTE_TIMELINE_ITEMS);

    if (options.emit !== false) {
      this.emit({
        type: "timeline_add",
        sessionId: run.snapshot.sessionId,
        item: cloneTimelineItem(item),
      });
    }

    return item;
  }

  private updateTimelineItem(
    run: ActiveRemoteRun,
    itemId: string,
    updater: (item: RemoteTimelineItem) => RemoteTimelineItem,
  ): void {
    const index = run.snapshot.timeline.findIndex((item) => item.id === itemId);
    if (index < 0) {
      if (run.currentToolItemId === itemId) {
        run.currentToolItemId = null;
        run.currentToolName = null;
      }
      return;
    }

    const nextItem = updater(run.snapshot.timeline[index]!);
    run.snapshot.timeline = [
      ...run.snapshot.timeline.slice(0, index),
      nextItem,
      ...run.snapshot.timeline.slice(index + 1),
    ];
    this.emit({
      type: "timeline_update",
      sessionId: run.snapshot.sessionId,
      item: cloneTimelineItem(nextItem),
    });
  }

  private touchRun(run: ActiveRemoteRun): string {
    const now = new Date().toISOString();
    run.snapshot.updatedAt = now;
    return now;
  }

  private emit(payload: RemoteStreamEventPayload): void {
    if (this.listeners.size === 0) {
      this.streamCursor += 1;
      return;
    }

    const event: RemoteStreamEvent = {
      id: ++this.streamCursor,
      sentAt: new Date().toISOString(),
      payload,
    };

    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async publishSessionSync(): Promise<void> {
    const recentSessions = await this.listProjectSessions();
    const lastSessionId = this.currentRun?.snapshot.sessionId || this.lastSessionId || recentSessions[0]?.id || null;
    const lastSession = lastSessionId ? await this.getSessionDetails(lastSessionId) : null;

    this.emit({
      type: "session",
      recentSessions,
      lastSession,
    });
  }

  private async listProjectSessions() {
    const sessions = await this.options.sessionStore.list(50);
    return sessions
      .filter((session) => session.cwd === this.options.cwd)
      .slice(0, 8)
      .map(toRemoteSessionSummary);
  }
}

function pushEvent(snapshot: RemoteRunSnapshot, event: RemoteRunEvent): void {
  snapshot.events = [...snapshot.events, event].slice(-MAX_REMOTE_EVENTS);
}

function appendPreview(current: string | undefined, delta: string): string {
  return truncatePreview(`${current ?? ""}${delta}`);
}

function truncatePreview(value: string): string {
  if (value.length <= MAX_REMOTE_PREVIEW_CHARS) {
    return value;
  }

  return `${value.slice(-MAX_REMOTE_PREVIEW_CHARS)}\n\n... [older preview truncated]`;
}

function truncateForEvent(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }

  return `${normalized.slice(0, 240)}...`;
}

function appendTimelineText(current: string, delta: string, maxChars: number): string {
  if (`${current}${delta}`.length <= maxChars) {
    return `${current}${delta}`;
  }

  return `${current}${delta}`.slice(-maxChars);
}

function truncateTimelineText(value: string): string {
  if (value.length <= MAX_REMOTE_TIMELINE_TEXT_CHARS) {
    return value;
  }

  return `${value.slice(-MAX_REMOTE_TIMELINE_TEXT_CHARS)}\n\n... [older content truncated]`;
}

function cloneSnapshot(snapshot: RemoteRunSnapshot): RemoteRunSnapshot {
  return {
    ...snapshot,
    events: [...snapshot.events],
    timeline: snapshot.timeline.map(cloneTimelineItem),
  };
}

function cloneTimelineItem(item: RemoteTimelineItem): RemoteTimelineItem {
  return {
    ...item,
    todoItems: item.todoItems ? item.todoItems.map((todo) => ({ ...todo })) : undefined,
    file: item.file ? { ...item.file } : undefined,
  };
}

function mergeTimelineItems(
  baseItems: RemoteTimelineItem[],
  supplementalItems: RemoteTimelineItem[],
): RemoteTimelineItem[] {
  const itemMap = new Map<string, RemoteTimelineItem>();
  const orderedIds: string[] = [];

  for (const item of [...baseItems, ...supplementalItems]) {
    if (!item?.id) {
      continue;
    }

    if (!itemMap.has(item.id)) {
      orderedIds.push(item.id);
    }

    itemMap.set(item.id, cloneTimelineItem(item));
  }

  return orderedIds
    .map((id) => itemMap.get(id))
    .filter((item): item is RemoteTimelineItem => Boolean(item))
    .slice(-MAX_REMOTE_TIMELINE_ITEMS);
}

function collectAutoShareCandidates(changedPaths: string[], cwd: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const changedPath of changedPaths) {
    const normalizedPath = path.normalize(changedPath);
    if (seen.has(normalizedPath)) {
      continue;
    }

    seen.add(normalizedPath);

    const relativePath = path.relative(cwd, normalizedPath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      continue;
    }

    if (!shouldAutoSharePath(relativePath)) {
      continue;
    }

    candidates.push(normalizedPath);
  }

  return candidates;
}

function shouldAutoSharePath(relativePath: string): boolean {
  return AUTO_SHARE_DOCUMENT_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function serializeSharedFileSummary(sharedFile: NonNullable<RemoteTimelineItem["file"]>): string {
  return JSON.stringify(
    {
      ok: true,
      shareId: sharedFile.shareId,
      fileName: sharedFile.fileName,
      relativePath: sharedFile.relativePath,
      size: sharedFile.size,
      createdAt: sharedFile.createdAt,
      downloadPath: sharedFile.downloadPath,
    },
    null,
    2,
  );
}
