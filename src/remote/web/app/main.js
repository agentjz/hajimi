import { CONNECTION_LABELS, STATUS_LABELS } from "./constants.js";
import { autoResizeTextarea, getElements, isNearBottom, scrollToBottom } from "./dom.js";
import { fetchJson, openEventStream } from "./network.js";
import { buildMessageElement } from "./timeline.js";

export function startRemoteApp() {
  const els = getElements();
  const state = createInitialState();
  const timelineNodes = new Map();

  function createInitialState() {
    return {
      hasConnectedOnce: false,
      shouldAutoScroll: true,
      connection: "idle",
      reconnectAttempt: 0,
      reconnectTimer: null,
      streamController: null,
      lastEventId: 0,
      lastDisconnectReason: "",
      projectCwd: "",
      currentRun: null,
      lastSession: null,
      renderedTimelineSessionId: null,
      renderedTimelineKey: "empty",
      expandedItems: new Set(),
      footerOverride: "",
      footerOverrideError: false,
      footerOverrideTimer: null,
      activeConversationSessionId: null,
      isNewConversationDraft: true,
    };
  }

  function showFooterMessage(message, isError = false, timeoutMs = 2400) {
    clearFooterOverride(false);
    state.footerOverride = message;
    state.footerOverrideError = Boolean(isError);
    if (timeoutMs > 0) {
      state.footerOverrideTimer = window.setTimeout(() => {
        clearFooterOverride();
      }, timeoutMs);
    }
    renderAppChrome();
  }

  function clearFooterOverride(shouldRender = true) {
    if (state.footerOverrideTimer) {
      window.clearTimeout(state.footerOverrideTimer);
      state.footerOverrideTimer = null;
    }

    state.footerOverride = "";
    state.footerOverrideError = false;

    if (shouldRender) {
      renderAppChrome();
    }
  }

  function getDisplayedRun() {
    if (!state.currentRun) {
      return null;
    }

    if (state.currentRun.status === "running") {
      return state.currentRun;
    }

    if (state.activeConversationSessionId && state.currentRun.sessionId === state.activeConversationSessionId) {
      return state.currentRun;
    }

    return null;
  }

  function getDisplayedSessionId() {
    return getDisplayedRun()?.sessionId || state.activeConversationSessionId;
  }

  function setActiveConversation(sessionId) {
    state.activeConversationSessionId = sessionId || null;
    state.isNewConversationDraft = !sessionId;
  }

  function resetToNewConversation({ focusInput = false } = {}) {
    clearFooterOverride(false);
    setActiveConversation(null);
    state.shouldAutoScroll = true;
    state.renderedTimelineSessionId = null;
    state.renderedTimelineKey = "empty";
    state.expandedItems.clear();
    timelineNodes.clear();
    els.timeline.textContent = "";
    els.chatScroll.scrollTop = 0;
    els.promptInput.value = "";
    autoResizeTextarea(els.promptInput);
    syncTimelineFromState(true, "preserve");
    renderAppChrome();

    if (focusInput) {
      requestAnimationFrame(() => {
        els.promptInput.focus();
      });
    }
  }

  function renderAppChrome() {
    const displayedRun = getDisplayedRun();
    const isRunning = displayedRun?.status === "running";

    els.streamPill.textContent = CONNECTION_LABELS[state.connection] || CONNECTION_LABELS.idle;
    els.runPill.textContent = resolveRunPill(displayedRun);
    els.composerNote.textContent = resolveFooterText(displayedRun);
    els.composerNote.classList.toggle("is-error", resolveFooterIsError());
    els.sendButton.disabled = isRunning || state.connection !== "connected";
    els.stopButton.disabled = !isRunning;
    els.newConversationButton.disabled = isRunning;

    autoResizeTextarea(els.promptInput);
  }

  function resolveRunPill(displayedRun = getDisplayedRun()) {
    if (displayedRun) {
      return STATUS_LABELS[displayedRun.status] || displayedRun.status;
    }

    return STATUS_LABELS.idle;
  }

  function resolveFooterText(displayedRun = getDisplayedRun()) {
    return state.footerOverride || resolveStatusLine(displayedRun);
  }

  function resolveFooterIsError() {
    return Boolean(state.footerOverride && state.footerOverrideError) || state.connection === "reconnecting";
  }

  function resolveStatusLine(displayedRun = getDisplayedRun()) {
    if (state.connection === "connecting") {
      return "正在连接远程聊天页...";
    }

    if (state.connection === "reconnecting") {
      return state.lastDisconnectReason
        ? `${state.lastDisconnectReason}，正在自动重连。`
        : "连接刚刚断开，正在自动重连。";
    }

    if (displayedRun) {
      if (displayedRun.status === "running") {
        return displayedRun.statusText
          ? `正在回复中：${displayedRun.statusText}`
          : "正在处理这条消息。";
      }

      if (displayedRun.status === "completed") {
        return "这条消息已经回复完成，可以继续发送。";
      }

      if (displayedRun.status === "failed") {
        return displayedRun.error
          ? `这条消息处理失败：${displayedRun.error}`
          : "这条消息处理失败。";
      }

      if (displayedRun.status === "cancelled") {
        return "这条消息已经停止。";
      }
    }

    if (state.isNewConversationDraft) {
      return "这是新的空对话，发出第一条消息就开始。";
    }

    if (state.activeConversationSessionId) {
      return "当前对话已就绪，可以继续发送。";
    }

    return "连接建立后就可以开始聊天。";
  }

  function getDistanceFromBottom(container) {
    return Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
  }

  function maybeScrollTimeline(mode, previousDistance = 0) {
    if (timelineNodes.size === 0) {
      return;
    }

    requestAnimationFrame(() => {
      if (mode === "bottom" || (mode === "if-near-bottom" && state.shouldAutoScroll)) {
        scrollToBottom(els.chatScroll);
        state.shouldAutoScroll = true;
        return;
      }

      if (previousDistance > 0) {
        els.chatScroll.scrollTop = Math.max(
          0,
          els.chatScroll.scrollHeight - els.chatScroll.clientHeight - previousDistance,
        );
      }
    });
  }

  function getDisplayedTimelineSource() {
    const displayedRun = getDisplayedRun();
    const activeSessionId = getDisplayedSessionId();
    const runTimeline = Array.isArray(displayedRun?.timeline) ? displayedRun.timeline : [];
    const lastTimeline = state.lastSession && state.lastSession.id === activeSessionId && Array.isArray(state.lastSession.timeline)
      ? state.lastSession.timeline
      : [];

    if (displayedRun) {
      const items = state.lastSession && state.lastSession.id === displayedRun.sessionId
        ? mergeTimelineItems(lastTimeline, runTimeline)
        : runTimeline;
      return {
        sessionId: displayedRun.sessionId,
        items,
        key: buildTimelineKey(displayedRun.sessionId, items),
      };
    }

    if (activeSessionId && lastTimeline.length > 0) {
      return {
        sessionId: activeSessionId,
        items: lastTimeline,
        key: buildTimelineKey(activeSessionId, lastTimeline),
      };
    }

    return {
      sessionId: null,
      items: [],
      key: "empty",
    };
  }

  function buildTimelineKey(sessionId, items) {
    const itemKeys = items.map((item) => `${item.id}:${item.updatedAt || item.createdAt}:${item.state}`);
    return `${sessionId || "none"}::${itemKeys.join("|")}`;
  }

  function mergeTimelineItems(baseItems, overlayItems) {
    const itemsById = new Map();
    const orderedIds = [];

    for (const item of [...baseItems, ...overlayItems]) {
      if (!item?.id) {
        continue;
      }

      if (!itemsById.has(item.id)) {
        orderedIds.push(item.id);
      }

      itemsById.set(item.id, item);
    }

    return orderedIds
      .map((id) => itemsById.get(id))
      .filter(Boolean);
  }

  function syncTimelineFromState(force = false, scrollMode = "preserve") {
    const source = getDisplayedTimelineSource();
    const shouldReset = force || source.key !== state.renderedTimelineKey;

    if (!shouldReset) {
      return;
    }

    const previousDistance = getDistanceFromBottom(els.chatScroll);
    state.renderedTimelineSessionId = source.sessionId;
    state.renderedTimelineKey = source.key;
    timelineNodes.clear();
    els.timeline.textContent = "";

    for (const item of source.items) {
      appendTimelineItem(item, false);
    }

    maybeScrollTimeline(scrollMode, previousDistance);
  }

  function appendTimelineItem(item, shouldScroll) {
    if (!item || !item.id || timelineNodes.has(item.id)) {
      return;
    }

    const element = buildMessageElement(item, {
      expandedItems: state.expandedItems,
      onExpand: () => {
        maybeScrollTimeline("if-near-bottom");
      },
    });

    timelineNodes.set(item.id, element);
    els.timeline.appendChild(element);

    if (shouldScroll) {
      maybeScrollTimeline("bottom");
    }
  }

  function updateTimelineItem(item, shouldScroll) {
    if (!item || !item.id) {
      return;
    }

    const existing = timelineNodes.get(item.id);
    if (!existing) {
      appendTimelineItem(item, shouldScroll);
      return;
    }

    const next = buildMessageElement(item, {
      expandedItems: state.expandedItems,
      onExpand: () => {
        maybeScrollTimeline("if-near-bottom");
      },
    });

    existing.replaceWith(next);
    timelineNodes.set(item.id, next);

    if (shouldScroll) {
      maybeScrollTimeline("bottom");
    }
  }

  function applySnapshot(snapshot) {
    const isInitialSnapshot = !state.hasConnectedOnce;
    state.hasConnectedOnce = true;
    state.connection = "connected";
    state.reconnectAttempt = 0;
    state.lastDisconnectReason = "";
    state.projectCwd = snapshot.projectCwd || "";
    state.currentRun = snapshot.currentRun || null;
    state.lastSession = snapshot.lastSession || null;
    state.lastEventId = typeof snapshot.streamCursor === "number" ? snapshot.streamCursor : state.lastEventId;
    state.renderedTimelineSessionId = null;
    state.renderedTimelineKey = "empty";

    if (state.currentRun?.status === "running") {
      setActiveConversation(state.currentRun.sessionId);
    } else if (isInitialSnapshot) {
      setActiveConversation(null);
      state.expandedItems.clear();
    }

    clearFooterOverride(false);
    state.shouldAutoScroll = true;
    syncTimelineFromState(true, state.currentRun?.status === "running" ? "bottom" : "preserve");
    renderAppChrome();
  }

  function applyRunUpdate(run) {
    const previousSessionId = getDisplayedSessionId();
    state.currentRun = run || null;

    if (run?.status === "running") {
      setActiveConversation(run.sessionId);
    }

    if (run && Array.isArray(run.timeline)) {
      const shouldForceSync = run.sessionId !== previousSessionId || timelineNodes.size === 0;
      syncTimelineFromState(shouldForceSync, "if-near-bottom");
    } else {
      syncTimelineFromState(false, "preserve");
    }

    renderAppChrome();
  }

  function applyTimelineEvent(payload, isAppend) {
    if (!state.currentRun || state.currentRun.sessionId !== payload.sessionId) {
      return;
    }

    const shouldStick = state.shouldAutoScroll || isNearBottom(els.chatScroll);
    const timeline = Array.isArray(state.currentRun.timeline) ? state.currentRun.timeline.slice() : [];
    const index = timeline.findIndex((item) => item.id === payload.item.id);

    if (index >= 0) {
      timeline[index] = payload.item;
    } else if (isAppend) {
      timeline.push(payload.item);
    } else {
      timeline.push(payload.item);
    }

    state.currentRun = { ...state.currentRun, timeline };
    state.renderedTimelineKey = buildTimelineKey(payload.sessionId, getDisplayedTimelineSource().items);

    if (state.renderedTimelineSessionId === payload.sessionId) {
      if (index >= 0) {
        updateTimelineItem(payload.item, shouldStick);
      } else {
        appendTimelineItem(payload.item, shouldStick);
      }
    } else {
      syncTimelineFromState(true, shouldStick ? "bottom" : "preserve");
    }

    renderAppChrome();
  }

  function applySessionUpdate(payload) {
    state.lastSession = payload.lastSession || null;
    syncTimelineFromState(false, "if-near-bottom");
    renderAppChrome();
  }

  function handleStreamEvent(eventMessage) {
    if (typeof eventMessage.id === "number" && eventMessage.id < state.lastEventId) {
      return;
    }

    if (typeof eventMessage.id === "number") {
      state.lastEventId = eventMessage.id;
    }

    switch (eventMessage.event) {
      case "snapshot":
        applySnapshot(eventMessage.data.state);
        break;
      case "run":
        applyRunUpdate(eventMessage.data.run);
        break;
      case "timeline_add":
        applyTimelineEvent(eventMessage.data, true);
        break;
      case "timeline_update":
        applyTimelineEvent(eventMessage.data, false);
        break;
      case "session":
        applySessionUpdate(eventMessage.data);
        break;
      default:
        break;
    }
  }

  async function connectToRemote() {
    clearReconnectTimer();

    state.connection = state.hasConnectedOnce ? "reconnecting" : "connecting";
    renderAppChrome();

    if (state.streamController) {
      state.streamController.abort();
    }

    const controller = new AbortController();
    state.streamController = controller;

    try {
      await openEventStream({
        signal: controller.signal,
        onEvent: handleStreamEvent,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      scheduleReconnect(error instanceof Error ? error.message : String(error));
    } finally {
      if (state.streamController === controller) {
        state.streamController = null;
      }
    }
  }

  function scheduleReconnect(reason) {
    clearReconnectTimer();
    state.connection = "reconnecting";
    state.reconnectAttempt += 1;
    state.lastDisconnectReason = reason;
    renderAppChrome();

    const delay = Math.min(5000, 800 * Math.max(1, state.reconnectAttempt));
    state.reconnectTimer = window.setTimeout(() => {
      void connectToRemote();
    }, delay);
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  async function submitPrompt(prompt) {
    const startNewConversation = state.isNewConversationDraft || !state.activeConversationSessionId;
    const run = await fetchJson("/api/runs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        startNewConversation,
      }),
    });

    clearFooterOverride(false);
    state.currentRun = run;
    state.shouldAutoScroll = true;
    setActiveConversation(run.sessionId);
    els.promptInput.value = "";
    autoResizeTextarea(els.promptInput);
    syncTimelineFromState(true, "bottom");
    renderAppChrome();
  }

  async function cancelCurrentRun() {
    await fetchJson("/api/runs/current/cancel", {
      method: "POST",
    });

    showFooterMessage("已经发出停止请求。");
  }

  els.composerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = els.promptInput.value.trim();
    if (!prompt) {
      showFooterMessage("请输入消息内容。", true, 3200);
      return;
    }

    if (state.connection !== "connected") {
      showFooterMessage("连接还没有准备好，请稍等一下。", true, 3200);
      return;
    }

    if (getDisplayedRun()?.status === "running") {
      showFooterMessage("当前还有一条消息在回复中，请先等它结束。", true, 3200);
      return;
    }

    try {
      await submitPrompt(prompt);
    } catch (error) {
      showFooterMessage(error instanceof Error ? error.message : String(error), true, 3200);
    }
  });

  els.stopButton.addEventListener("click", async () => {
    try {
      els.stopButton.disabled = true;
      await cancelCurrentRun();
    } catch (error) {
      showFooterMessage(error instanceof Error ? error.message : String(error), true, 3200);
    } finally {
      renderAppChrome();
    }
  });

  els.newConversationButton.addEventListener("click", () => {
    if (getDisplayedRun()?.status === "running") {
      return;
    }

    resetToNewConversation({ focusInput: true });
  });

  els.promptInput.addEventListener("input", () => {
    autoResizeTextarea(els.promptInput);
  });

  els.chatScroll.addEventListener("scroll", () => {
    state.shouldAutoScroll = isNearBottom(els.chatScroll);
  });

  window.addEventListener("beforeunload", () => {
    clearReconnectTimer();
    clearFooterOverride(false);
    if (state.streamController) {
      state.streamController.abort();
    }
  });

  autoResizeTextarea(els.promptInput);
  renderAppChrome();
  void connectToRemote();
}
