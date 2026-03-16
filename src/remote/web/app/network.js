export async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);

  if (!response.ok) {
    let message = "请求失败。";
    try {
      const payload = await response.json();
      if (payload && typeof payload.error === "string") {
        message = payload.error;
      }
    } catch {
      message = `${response.status} ${response.statusText}`;
    }
    throw new Error(message);
  }

  return response.json();
}

export async function openEventStream({ signal, onEvent }) {
  const response = await fetch("/api/stream", {
    headers: {
      Accept: "text/event-stream",
    },
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error("SSE 连接建立失败。");
  }

  await consumeEventStream(response.body, signal, onEvent);

  if (!signal.aborted) {
    throw new Error("SSE 连接已断开。");
  }
}

async function consumeEventStream(stream, signal, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    buffer += decoder.decode(result.value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";

    for (const part of parts) {
      const eventMessage = parseEventChunk(part);
      if (eventMessage) {
        onEvent(eventMessage);
      }
    }

    if (signal.aborted) {
      break;
    }
  }

  const tail = decoder.decode();
  if (tail) {
    const eventMessage = parseEventChunk(buffer + tail);
    if (eventMessage) {
      onEvent(eventMessage);
    }
  }
}

function parseEventChunk(chunk) {
  if (!chunk.trim()) {
    return null;
  }

  let eventName = "message";
  let eventId = null;
  const dataLines = [];

  for (const line of chunk.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    let value = separator >= 0 ? line.slice(separator + 1) : "";
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      eventName = value;
    } else if (field === "id") {
      const parsed = Number.parseInt(value, 10);
      eventId = Number.isFinite(parsed) ? parsed : null;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  try {
    return {
      event: eventName,
      id: eventId,
      data: JSON.parse(dataLines.join("\n")),
    };
  } catch {
    return null;
  }
}
