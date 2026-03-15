export function authHeaders(token, extra = {}) {
  return token
    ? { Authorization: `Bearer ${token}`, ...extra }
    : { ...extra };
}

export function createAuthError(message) {
  const error = new Error(message);
  error.name = "AuthError";
  return error;
}

export function isAuthError(error) {
  return error && error.name === "AuthError";
}

export async function fetchJson(url, options = {}) {
  const { token, headers, ...rest } = options;
  const response = await fetch(url, {
    ...rest,
    headers: authHeaders(token, headers ?? {}),
  });

  if (response.status === 401) {
    throw createAuthError("令牌无效或已过期，请重新输入访问令牌。");
  }

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

export async function openEventStream({ token, signal, onEvent }) {
  const response = await fetch("/api/stream", {
    headers: authHeaders(token, {
      Accept: "text/event-stream",
    }),
    signal,
  });

  if (response.status === 401) {
    throw createAuthError("令牌无效或已过期，请重新输入访问令牌。");
  }

  if (!response.ok || !response.body) {
    throw new Error("SSE 连接建立失败。");
  }

  await consumeEventStream(response.body, signal, onEvent);

  if (!signal.aborted) {
    throw new Error("SSE 连接已断开。");
  }
}

export async function downloadSharedFile(file, token) {
  if (!file || !file.downloadPath) {
    throw new Error("找不到可下载的文件信息。");
  }

  const response = await fetch(file.downloadPath, {
    headers: authHeaders(token, { Accept: "*/*" }),
  });

  if (response.status === 401) {
    throw createAuthError("令牌无效或已过期，请重新输入访问令牌。");
  }

  if (!response.ok) {
    let message = "文件下载失败。";
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

  return {
    blob: await response.blob(),
    fileName: file.fileName || "shared-file",
  };
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
