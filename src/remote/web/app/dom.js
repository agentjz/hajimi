function requireElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing remote UI element: #${id}`);
  }

  return element;
}

export function getElements() {
  return {
    connectScreen: requireElement("connect-screen"),
    appScreen: requireElement("app-screen"),
    connectForm: requireElement("connect-form"),
    tokenInput: requireElement("token-input"),
    connectButton: requireElement("connect-button"),
    connectMessage: requireElement("connect-message"),
    streamPill: requireElement("stream-pill"),
    runPill: requireElement("run-pill"),
    projectPath: requireElement("project-path"),
    newConversationButton: requireElement("new-conversation-button"),
    emptyState: requireElement("empty-state"),
    timeline: requireElement("timeline"),
    chatScroll: requireElement("chat-scroll"),
    composerForm: requireElement("composer-form"),
    promptInput: requireElement("prompt-input"),
    sendButton: requireElement("send-button"),
    stopButton: requireElement("stop-button"),
    composerNote: requireElement("composer-note"),
  };
}

export function autoResizeTextarea(textarea, maxHeight = 180) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
}

export function isNearBottom(container, threshold = 100) {
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
  return distance < threshold;
}

export function scrollToBottom(container) {
  if (typeof container.scrollTo === "function") {
    container.scrollTo({
      top: container.scrollHeight,
      behavior: "auto",
    });
    return;
  }

  container.scrollTop = container.scrollHeight;
}
