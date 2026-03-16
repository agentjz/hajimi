import { AgentTurnError, getErrorMessage } from "../agent/errors.js";
import { runManagedAgentTurn } from "../agent/managedTurn.js";
import { SessionStore } from "../agent/sessionStore.js";
import type { AgentCallbacks } from "../agent/types.js";
import { createRuntimeToolRegistry } from "../tools/index.js";
import type { ToolRegistry } from "../tools/index.js";
import type { RuntimeConfig } from "../types.js";
import { isAbortError } from "../utils/abort.js";
import { writeStdoutLine } from "../utils/stdio.js";
import { createRemoteTimelineItem, summarizeToolError } from "./timeline.js";
import { toRemoteSessionDetails } from "./sessionViews.js";
import type {
  RemoteControlProtocol,
  RemoteRunSnapshot,
  RemoteStateSnapshot,
  RemoteStreamEvent,
  RemoteStreamEventPayload,
  RemoteStreamListener,
  RemoteSubmitPromptOptions,
  RemoteTimelineItem,
  RemoteTimelineItemKind,
  RemoteTimelineItemState,
} from "./types.js";

const MAX_REMOTE_TIMELINE_ITEMS = 240;
const MAX_REMOTE_TIMELINE_TEXT_CHARS = 32_000;

export interface RemoteControlServiceOptions {
  cwd: string;
  config: RuntimeConfig;
  sessionStore: SessionStore;
  runTurn?: typeof runManagedAgentTurn;
  writeTerminalLine?: (line: string) => void;
}

interface ActiveRemoteRun {
  snapshot: RemoteRunSnapshot;
  controller: AbortController;
  promise: Promise<void>;
  itemCounter: number;
  pendingReasoningText: string;
  currentToolItemId: string | null;
}

export class RemoteControlService implements RemoteControlProtocol {
  private readonly runTurn: typeof runManagedAgentTurn;
  private readonly writeTerminalLine: (line: string) => void;
  private readonly listeners = new Set<RemoteStreamListener>();
  private currentRun: ActiveRemoteRun | null = null;
  private lastSessionId: string | null = null;
  private streamCursor = 0;
  private toolRegistryPromise: Promise<ToolRegistry> | null = null;

  constructor(private readonly options: RemoteControlServiceOptions) {
    this.runTurn = options.runTurn ?? runManagedAgentTurn;
    this.writeTerminalLine = options.writeTerminalLine ?? writeStdoutLine;
  }

  async getState(): Promise<RemoteStateSnapshot> {
    return {
      streamCursor: this.streamCursor,
      projectCwd: this.options.cwd,
      currentRun: this.currentRun ? cloneSnapshot(this.currentRun.snapshot) : null,
      lastSession: await this.getLastSessionDetails(),
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
      timeline: prepared.timeline.map(cloneTimelineItem),
    };

    const run: ActiveRemoteRun = {
      snapshot,
      controller: new AbortController(),
      promise: Promise.resolve(),
      itemCounter: snapshot.timeline.length,
      pendingReasoningText: "",
      currentToolItemId: null,
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
      run: cloneSnapshot(run.snapshot),
    });
    void this.publishSessionSync();

    return cloneSnapshot(run.snapshot);
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
      return this.loadPreparedSession(this.currentRun.snapshot.sessionId);
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

  private async loadPreparedSession(sessionId: string): Promise<{
    session: Awaited<ReturnType<SessionStore["save"]>>;
    timeline: RemoteTimelineItem[];
  }> {
    const session = await this.options.sessionStore.load(sessionId);
    const details = toRemoteSessionDetails(session);
    return {
      session,
      timeline: details.timeline.map(cloneTimelineItem),
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
        // ignore missing sessions and fall through to recents
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

      const updatedAt = this.touchRun(run);
      this.flushReasoningItem(run, updatedAt);
      this.finalizeCurrentToolItem(run, updatedAt, "done");
      this.replaceTimelineWithSession(run, result.session);
      run.snapshot.status = "completed";
      run.snapshot.updatedAt = updatedAt;
      run.snapshot.finishedAt = updatedAt;
      run.snapshot.statusText = "任务已完成";
      this.lastSessionId = result.session.id;
      this.addTimelineItem(run, {
        kind: "status",
        text: "任务已完成，可以继续发送下一条消息。",
        createdAt: updatedAt,
      });
      this.emit({
        type: "run",
        run: cloneSnapshot(run.snapshot),
      });
      await this.publishSessionSync();
      return;
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
      this.toolRegistryPromise = createRuntimeToolRegistry(this.options.config);
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
      onAssistantDelta: () => {
        this.touchRun(run);
      },
      onAssistantText: () => {
        this.touchRun(run);
      },
      onAssistantDone: (fullText) => {
        const now = this.touchRun(run);
        this.flushReasoningItem(run, now);
        this.writeFinalAnswer(fullText);
        this.addTimelineItem(run, {
          kind: "final_answer",
          text: truncateTimelineText(fullText),
          createdAt: now,
        });
      },
      onReasoningDelta: (delta) => {
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
        this.writeToolLine(name);

        const item = this.addTimelineItem(run, {
          kind: "tool_use",
          text: "",
          createdAt: now,
          toolName: name,
          state: "streaming",
          summary: "运行中",
          collapsed: true,
        });
        run.currentToolItemId = item.id;
      },
      onToolResult: (_name, _output) => {
        const now = this.touchRun(run);
        this.finalizeCurrentToolItem(run, now, "done");
      },
      onToolError: (name, error) => {
        const now = this.touchRun(run);
        this.finalizeCurrentToolItem(run, now, "error");
        this.addTimelineItem(run, {
          kind: "error",
          text: summarizeToolError(error, name),
          createdAt: now,
          state: "error",
        });
      },
    };
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
  }

  private replaceTimelineWithSession(
    run: ActiveRemoteRun,
    session: Awaited<ReturnType<SessionStore["save"]>>,
  ): void {
    const details = toRemoteSessionDetails(session);
    run.snapshot.timeline = details.timeline.map(cloneTimelineItem).slice(-MAX_REMOTE_TIMELINE_ITEMS);
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
    this.emit({
      type: "session",
      lastSession: await this.getLastSessionDetails(),
    });
  }

  private writeToolLine(name: string): void {
    const normalizedName = name.trim();
    if (!normalizedName) {
      return;
    }

    this.writeTerminalLine(`[remote] Tool: ${normalizedName}`);
  }

  private writeFinalAnswer(fullText: string): void {
    const normalized = fullText.trim();
    if (!normalized) {
      return;
    }

    if (!normalized.includes("\n")) {
      this.writeTerminalLine(`[remote] Final: ${normalized}`);
      return;
    }

    this.writeTerminalLine("[remote] Final:");
    for (const line of normalized.split(/\r?\n/)) {
      this.writeTerminalLine(line);
    }
  }

  private async getLastSessionDetails() {
    const preferredIds = [
      this.currentRun?.snapshot.sessionId ?? null,
      this.lastSessionId,
    ].filter((value): value is string => Boolean(value));

    for (const sessionId of preferredIds) {
      try {
        const session = await this.options.sessionStore.load(sessionId);
        if (session.cwd === this.options.cwd) {
          return toRemoteSessionDetails(session);
        }
      } catch {
        // ignore missing sessions and fall through to the latest persisted one
      }
    }

    const fallback = await this.loadContinuationSession();
    return fallback ? toRemoteSessionDetails(fallback) : null;
  }
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
    timeline: snapshot.timeline.map(cloneTimelineItem),
  };
}

function cloneTimelineItem(item: RemoteTimelineItem): RemoteTimelineItem {
  return {
    ...item,
  };
}
