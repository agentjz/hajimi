import { CONNECTION_LABELS, STATUS_LABELS, TOKEN_KEY } from "./constants.js";
import { autoResizeTextarea, getElements, isNearBottom, scrollToBottom } from "./dom.js";
import { downloadSharedFile, fetchJson, isAuthError, openEventStream } from "./network.js";
import { buildMessageElement } from "./timeline.js";

export function startRemoteApp() {
  const els = getElements();
  const state = createInitialState();
  const timelineNodes = new Map();

  function createInitialState() {
    return {
      token: localStorage.getItem(TOKEN_KEY) || "",
      hasSnapshot: false,
      shouldAutoScroll: true,
      connection: "idle",
      reconnectAttempt: 0,
      reconnectTimer: null,
      streamController: null,
      lastEventId: 0,
      projectCwd: "",
      currentRun: null,
      lastSession: null,
      recentSessions: [],
      connectMessage: "等待连接。",
      connectError: false,
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

  function setConnectMessage(message, isError) {
    state.connectMessage = message;
    state.connectError = Boolean(isError);
    renderAppChrome();
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
    els.tokenInput.value = state.token;
    els.connectButton.disabled = state.connection === "connecting";

    const showApp = state.hasSnapshot;
    const displayedRun = getDisplayedRun();
    els.connectScreen.classList.toggle("hidden", showApp);
    els.appScreen.classList.toggle("hidden", !showApp);

    els.connectMessage.textContent = state.connectMessage;
    els.connectMessage.classList.toggle("is-error", state.connectError);

    if (!showApp) {
      return;
    }

    const isRunning = Boolean(displayedRun && displayedRun.status === "running");
    els.streamPill.textContent = CONNECTION_LABELS[state.connection] || CONNECTION_LABELS.idle;
    els.runPill.textContent = resolveRunPill(displayedRun);
    els.projectPath.textContent = state.projectCwd || "准备聊天目录中...";
    els.projectPath.title = state.projectCwd || "";
    els.composerNote.textContent = resolveFooterText(displayedRun);
    els.composerNote.classList.toggle("is-error", resolveFooterIsError());
    els.sendButton.disabled = isRunning;
    els.stopButton.disabled = !isRunning;
    els.newConversationButton.disabled = isRunning;
    els.emptyState.classList.toggle("hidden", timelineNodes.size > 0);

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
    return Boolean(state.footerOverride && state.footerOverrideError);
  }

  function resolveStatusLine(displayedRun = getDisplayedRun()) {
    if (state.connection === "reconnecting") {
      return "刚刚断开了一下，正在自动重连。";
    }

    if (displayedRun) {
      if (displayedRun.status === "running") {
        return displayedRun.statusText
          ? `正在回复中：${displayedRun.statusText}`
          : "正在接着这段对话往下回复。";
      }

      if (displayedRun.status === "completed") {
        return "这条消息已经回完了，可以继续聊。";
      }

      if (displayedRun.status === "failed") {
        return displayedRun.error
          ? `这条消息处理得不太顺：${displayedRun.error}`
          : "这条消息处理得不太顺。";
      }

      if (displayedRun.status === "cancelled") {
        return "这条消息已经停下来了。";
      }
    }

    if (state.isNewConversationDraft) {
      return "这是新的对话，发出第一条消息就开始。";
    }

    if (state.activeConversationSessionId) {
      return "这段对话已经准备好了，可以继续聊。";
    }

    return "连上以后，就能在这里开始聊天。";
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

    els.emptyState.classList.toggle("hidden", source.items.length > 0);
    maybeScrollTimeline(scrollMode, previousDistance);
  }

  function appendTimelineItem(item, shouldScroll) {
    if (!item || !item.id || timelineNodes.has(item.id)) {
      return;
    }

    const element = buildMessageElement(item, {
      expandedItems: state.expandedItems,
      onDownloadFile: (nextItem, button) => {
        void handleFileDownload(nextItem, button);
      },
    });

    timelineNodes.set(item.id, element);
    els.timeline.appendChild(element);
    els.emptyState.classList.add("hidden");

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
      onDownloadFile: (nextItem, button) => {
        void handleFileDownload(nextItem, button);
      },
    });

    existing.replaceWith(next);
    timelineNodes.set(item.id, next);

    if (shouldScroll) {
      maybeScrollTimeline("bottom");
    }
  }

  async function handleFileDownload(item, button) {
    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = "准备下载...";

    try {
      const { blob, fileName } = await downloadSharedFile(item.file, state.token);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showFooterMessage("文件已经开始下载。");
    } catch (error) {
      if (isAuthError(error)) {
        handleAuthFailure(error.message || String(error));
        return;
      }

      showFooterMessage(error instanceof Error ? error.message : String(error), true, 3200);
    } finally {
      button.disabled = false;
      button.textContent = previousText;
    }
  }

  function applySnapshot(snapshot) {
    const isInitialSnapshot = !state.hasSnapshot;
    state.hasSnapshot = true;
    state.connection = "connected";
    state.reconnectAttempt = 0;
    state.projectCwd = snapshot.projectCwd || "";
    state.currentRun = snapshot.currentRun || null;
    state.lastSession = snapshot.lastSession || null;
    state.recentSessions = Array.isArray(snapshot.recentSessions) ? snapshot.recentSessions : [];
    state.lastEventId = typeof snapshot.streamCursor === "number" ? snapshot.streamCursor : state.lastEventId;
    state.renderedTimelineSessionId = null;
    state.renderedTimelineKey = "empty";

    if (state.currentRun?.status === "running") {
      setActiveConversation(state.currentRun.sessionId);
    } else if (isInitialSnapshot) {
      setActiveConversation(null);
      state.expandedItems.clear();
    }

    setConnectMessage("已连接，可以开始聊天。", false);
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
    state.recentSessions = Array.isArray(payload.recentSessions) ? payload.recentSessions : [];
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

    if (!state.token.trim()) {
      setConnectMessage("请先输入访问令牌。", true);
      return;
    }

    state.token = state.token.trim();
    localStorage.setItem(TOKEN_KEY, state.token);
    state.connection = state.hasSnapshot ? "reconnecting" : "connecting";
    setConnectMessage("正在建立连接...", false);
    renderAppChrome();

    if (state.streamController) {
      state.streamController.abort();
    }

    const controller = new AbortController();
    state.streamController = controller;

    try {
      await openEventStream({
        token: state.token,
        signal: controller.signal,
        onEvent: handleStreamEvent,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      if (isAuthError(error)) {
        handleAuthFailure(error.message || String(error));
        return;
      }

      scheduleReconnect(error instanceof Error ? error.message : String(error));
    } finally {
      if (state.streamController === controller) {
        state.streamController = null;
      }
    }
  }

  function handleAuthFailure(message) {
    clearReconnectTimer();
    clearFooterOverride(false);
    state.hasSnapshot = false;
    state.shouldAutoScroll = true;
    state.connection = "idle";
    state.projectCwd = "";
    state.currentRun = null;
    state.lastSession = null;
    state.recentSessions = [];
    state.renderedTimelineSessionId = null;
    state.renderedTimelineKey = "empty";
    state.expandedItems.clear();
    setActiveConversation(null);
    timelineNodes.clear();
    els.timeline.textContent = "";
    els.promptInput.value = "";
    autoResizeTextarea(els.promptInput);
    setConnectMessage(message, true);
    renderAppChrome();
  }

  function scheduleReconnect(reason) {
    clearReconnectTimer();
    state.connection = "reconnecting";
    state.reconnectAttempt += 1;
    setConnectMessage(`${reason} 正在自动重连...`, true);
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
      token: state.token,
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
    state.hasSnapshot = true;
    state.shouldAutoScroll = true;
    setActiveConversation(run.sessionId);
    els.promptInput.value = "";
    autoResizeTextarea(els.promptInput);
    syncTimelineFromState(true, "bottom");
    renderAppChrome();
  }

  async function cancelCurrentRun() {
    await fetchJson("/api/runs/current/cancel", {
      token: state.token,
      method: "POST",
    });

    showFooterMessage("已经发出停止请求。");
  }

  els.connectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    state.token = els.tokenInput.value;
    void connectToRemote();
  });

  els.composerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = els.promptInput.value.trim();
    if (!prompt) {
      showFooterMessage("请输入消息内容。", true, 3200);
      return;
    }

    if (getDisplayedRun()?.status === "running") {
      showFooterMessage("当前还有一条消息在回复中，请先等它结束。", true, 3200);
      return;
    }

    try {
      await submitPrompt(prompt);
    } catch (error) {
      if (isAuthError(error)) {
        handleAuthFailure(error.message || String(error));
        return;
      }

      showFooterMessage(error instanceof Error ? error.message : String(error), true, 3200);
    }
  });

  els.stopButton.addEventListener("click", async () => {
    try {
      els.stopButton.disabled = true;
      await cancelCurrentRun();
    } catch (error) {
      if (isAuthError(error)) {
        handleAuthFailure(error.message || String(error));
        return;
      }

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

  if (state.token) {
    setConnectMessage("检测到已保存令牌，正在自动连接...", false);
    void connectToRemote();
  }
}
