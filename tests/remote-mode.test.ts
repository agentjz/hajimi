import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/agent/sessionStore.js";
import { resolveRuntimeConfig } from "../src/config/store.js";
import { startRemoteHttpServer } from "../src/remote/httpServer.js";
import { RemoteControlService } from "../src/remote/service.js";
import type { RuntimeConfig, StoredMessage, ToolCallRecord } from "../src/types.js";
import { createAbortError } from "../src/utils/abort.js";
import { createTempWorkspace } from "./helpers.js";

function createRuntimeConfig(root: string, sessionsDir: string): RuntimeConfig {
  return {
    provider: "deepseek",
    apiKey: "test-key",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-reasoner",
    mode: "agent",
    allowedRoots: ["."],
    yieldAfterToolSteps: 12,
    contextWindowMessages: 30,
    maxContextChars: 48_000,
    contextSummaryChars: 8_000,
    maxToolIterations: 8,
    maxContinuationBatches: 8,
    maxReadBytes: 120_000,
    maxSearchResults: 80,
    maxSpreadsheetPreviewRows: 20,
    maxSpreadsheetPreviewColumns: 12,
    commandStallTimeoutMs: 30_000,
    commandMaxRetries: 1,
    commandRetryBackoffMs: 1_500,
    showReasoning: true,
    remote: {
      enabled: true,
      host: "",
      port: 0,
      bind: "loopback",
      publicUrl: "",
    },
    mcp: {
      enabled: false,
      servers: [],
    },
    paths: {
      configDir: root,
      dataDir: root,
      cacheDir: root,
      configFile: path.join(root, "config.json"),
      sessionsDir,
      changesDir: path.join(root, "changes"),
    },
  };
}

test("resolveRuntimeConfig reads project-scoped remote values from .hajimi/.env", async (t) => {
  const rootA = await createTempWorkspace("remote-env-a", t);
  const rootB = await createTempWorkspace("remote-env-b", t);

  await fs.mkdir(path.join(rootA, ".hajimi"), { recursive: true });
  await fs.mkdir(path.join(rootB, ".hajimi"), { recursive: true });

  await fs.writeFile(
    path.join(rootA, ".hajimi", ".env"),
    [
      "HAJIMI_API_KEY=test-a",
      "HAJIMI_REMOTE_PORT=5101",
      "HAJIMI_REMOTE_HOST=10.1.1.10",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(rootB, ".hajimi", ".env"),
    [
      "HAJIMI_API_KEY=test-b",
      "HAJIMI_REMOTE_PORT=5102",
      "HAJIMI_REMOTE_HOST=10.1.1.11",
    ].join("\n"),
    "utf8",
  );

  const configA = await resolveRuntimeConfig({ cwd: rootA });
  const configB = await resolveRuntimeConfig({ cwd: rootB });

  assert.equal(configA.remote.port, 5101);
  assert.equal(configA.remote.host, "10.1.1.10");
  assert.equal(configB.remote.port, 5102);
  assert.equal(configB.remote.host, "10.1.1.11");
});

test("remote HTTP page serves split assets and renders phased chat state", async (t) => {
  const root = await createTempWorkspace("remote-http", t);
  const sessionsDir = path.join(root, "sessions");
  const sessionStore = new SessionStore(sessionsDir);
  const service = new RemoteControlService({
    cwd: root,
    config: createRuntimeConfig(root, sessionsDir),
    sessionStore,
    writeTerminalLine: () => undefined,
    runTurn: async (options) => {
      const toolCall = createToolCall("tool-1", "read_file", { path: "README.md" });

      options.callbacks?.onModelWaitStart?.();
      options.callbacks?.onStatus?.("Planning the remote task");
      options.callbacks?.onReasoningDelta?.("Inspecting the repository before replying.");
      options.callbacks?.onModelWaitStop?.();
      options.callbacks?.onToolCall?.("read_file", toolCall.function.arguments);
      options.callbacks?.onToolResult?.("read_file", JSON.stringify({ ok: true }, null, 2));
      options.callbacks?.onAssistantDone?.("Remote task output");

      const messages: StoredMessage[] = [
        createUserMessage(options.input),
        createAssistantMessage({
          reasoningContent: "Inspecting the repository before replying.",
          toolCalls: [toolCall],
        }),
        createToolMessage("read_file", JSON.stringify({ ok: true }, null, 2)),
        createAssistantMessage({
          content: "Remote task output",
        }),
      ];
      const session = await options.sessionStore.appendMessages(options.session, messages);
      return {
        session,
        changedPaths: [],
        verificationAttempted: false,
        yielded: false,
      };
    },
  });
  const server = await startRemoteHttpServer({
    protocol: service,
    listenHost: "127.0.0.1",
    displayHost: "127.0.0.1",
    port: 0,
  });

  t.after(async () => {
    await service.stop();
    await server.stop();
  });

  const html = await fetch(server.url);
  assert.equal(html.status, 200);
  const page = await html.text();
  assert.match(page, /哈基米远程/u);
  assert.match(page, /新建对话/u);
  assert.doesNotMatch(page, /访问令牌/u);
  assert.match(page, /\/assets\/remote\.css/u);
  assert.match(page, /\/assets\/remote\.js/u);

  const css = await fetch(`${server.url}/assets/remote.css`);
  assert.equal(css.status, 200);
  assert.match(await css.text(), /\.chat-shell/u);

  const script = await fetch(`${server.url}/assets/remote.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /startRemoteApp/u);

  const mainModule = await fetch(`${server.url}/assets/app/main.js`);
  assert.equal(mainModule.status, 200);
  assert.match(await mainModule.text(), /syncTimelineFromState/u);

  const initialState = await fetch(`${server.url}/api/state`);
  assert.equal(initialState.status, 200);

  const started = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "inspect the project" }),
  });
  assert.equal(started.status, 202);

  const state = await waitForRemoteState(
    server.url,
    (snapshot) => snapshot.currentRun?.status === "completed",
  );

  assert.equal(state.currentRun.status, "completed");
  assert.equal(state.currentRun.timeline.filter((item) => item.kind === "user").length, 1);
  assert.equal(state.currentRun.timeline.filter((item) => item.kind === "tool_use").length, 1);
  assert.equal(state.currentRun.timeline.filter((item) => item.kind === "final_answer").length, 1);
  assert.equal(state.currentRun.timeline.at(-1)?.kind, "status");
  assert.equal(state.lastSession?.timeline.filter((item) => item.kind === "final_answer").length, 1);
});

test("remote mirrors tool calls and final answers to terminal output", async (t) => {
  const root = await createTempWorkspace("remote-terminal-output", t);
  const sessionsDir = path.join(root, "sessions");
  const sessionStore = new SessionStore(sessionsDir);
  const terminalLines: string[] = [];
  const service = new RemoteControlService({
    cwd: root,
    config: createRuntimeConfig(root, sessionsDir),
    sessionStore,
    writeTerminalLine: (line) => {
      terminalLines.push(line);
    },
    runTurn: async (options) => {
      const toolCall = createToolCall("tool-1", "read_file", { path: "README.md" });

      options.callbacks?.onToolCall?.("read_file", toolCall.function.arguments);
      options.callbacks?.onToolResult?.("read_file", JSON.stringify({ ok: true }, null, 2));
      options.callbacks?.onAssistantDone?.("Remote task output");

      const messages: StoredMessage[] = [
        createUserMessage(options.input),
        createAssistantMessage({
          toolCalls: [toolCall],
        }),
        createToolMessage("read_file", JSON.stringify({ ok: true }, null, 2)),
        createAssistantMessage({
          content: "Remote task output",
        }),
      ];
      const session = await options.sessionStore.appendMessages(options.session, messages);
      return {
        session,
        changedPaths: [],
        verificationAttempted: false,
        yielded: false,
      };
    },
  });
  const server = await startRemoteHttpServer({
    protocol: service,
    listenHost: "127.0.0.1",
    displayHost: "127.0.0.1",
    port: 0,
  });

  t.after(async () => {
    await service.stop();
    await server.stop();
  });

  const started = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "inspect the project" }),
  });
  assert.equal(started.status, 202);

  await waitForRemoteState(
    server.url,
    (snapshot) => snapshot.currentRun?.status === "completed",
  );

  assert.deepEqual(terminalLines, [
    "[remote] Tool: read_file",
    "[remote] Final: Remote task output",
  ]);
});

test("remote keeps the same session and timeline when the next message continues the chat", async (t) => {
  const root = await createTempWorkspace("remote-continuation", t);
  const sessionsDir = path.join(root, "sessions");
  const sessionStore = new SessionStore(sessionsDir);
  const service = new RemoteControlService({
    cwd: root,
    config: createRuntimeConfig(root, sessionsDir),
    sessionStore,
    writeTerminalLine: () => undefined,
    runTurn: async (options) => {
      const previousUserMessages = options.session.messages
        .filter((message) => message.role === "user" && message.content)
        .map((message) => String(message.content));
      const prefix = previousUserMessages.length > 0
        ? `continuing from: ${previousUserMessages.join(" | ")}`
        : "starting fresh";
      const answer = `${prefix} -> ${options.input}`;

      options.callbacks?.onAssistantDone?.(answer);

      const messages: StoredMessage[] = [
        createUserMessage(options.input),
        createAssistantMessage({
          content: answer,
        }),
      ];
      const session = await options.sessionStore.appendMessages(options.session, messages);
      return {
        session,
        changedPaths: [],
        verificationAttempted: false,
        yielded: false,
      };
    },
  });
  const server = await startRemoteHttpServer({
    protocol: service,
    listenHost: "127.0.0.1",
    displayHost: "127.0.0.1",
    port: 0,
  });

  t.after(async () => {
    await service.stop();
    await server.stop();
  });

  const firstResponse = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "第一句" }),
  });
  assert.equal(firstResponse.status, 202);
  const firstRun = await firstResponse.json() as { sessionId: string };

  await waitForRemoteState(
    server.url,
    (snapshot) => snapshot.currentRun?.status === "completed" && snapshot.lastSession?.messages.length === 2,
  );

  const secondResponse = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "第二句" }),
  });
  assert.equal(secondResponse.status, 202);
  const secondRun = await secondResponse.json() as { sessionId: string };
  assert.equal(secondRun.sessionId, firstRun.sessionId);

  const state = await waitForRemoteState(
    server.url,
    (snapshot) => snapshot.currentRun?.status === "completed" && snapshot.lastSession?.messages.length === 4,
  );

  assert.equal(state.currentRun?.sessionId, firstRun.sessionId);
  assert.equal(state.lastSession?.id, firstRun.sessionId);
  assert.deepEqual(
    state.currentRun?.timeline.filter((item) => item.kind === "user").map((item) => item.text).slice(-2),
    ["第一句", "第二句"],
  );
  assert.match(
    String(state.currentRun?.timeline.filter((item) => item.kind === "final_answer").at(-1)?.text ?? ""),
    /continuing from: 第一句/u,
  );
});

test("remote can start a fresh conversation when the next message requests a new chat", async (t) => {
  const root = await createTempWorkspace("remote-new-chat", t);
  const sessionsDir = path.join(root, "sessions");
  const sessionStore = new SessionStore(sessionsDir);
  const service = new RemoteControlService({
    cwd: root,
    config: createRuntimeConfig(root, sessionsDir),
    sessionStore,
    writeTerminalLine: () => undefined,
    runTurn: async (options) => {
      const previousUserMessages = options.session.messages
        .filter((message) => message.role === "user" && message.content)
        .map((message) => String(message.content));
      const prefix = previousUserMessages.length > 0
        ? `continuing from: ${previousUserMessages.join(" | ")}`
        : "starting fresh";
      const answer = `${prefix} -> ${options.input}`;

      options.callbacks?.onAssistantDone?.(answer);

      const messages: StoredMessage[] = [
        createUserMessage(options.input),
        createAssistantMessage({
          content: answer,
        }),
      ];
      const session = await options.sessionStore.appendMessages(options.session, messages);
      return {
        session,
        changedPaths: [],
        verificationAttempted: false,
        yielded: false,
      };
    },
  });
  const server = await startRemoteHttpServer({
    protocol: service,
    listenHost: "127.0.0.1",
    displayHost: "127.0.0.1",
    port: 0,
  });

  t.after(async () => {
    await service.stop();
    await server.stop();
  });

  const firstResponse = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "第一句" }),
  });
  assert.equal(firstResponse.status, 202);
  const firstRun = await firstResponse.json() as { sessionId: string };

  await waitForRemoteState(
    server.url,
    (snapshot) => snapshot.currentRun?.status === "completed" && snapshot.lastSession?.messages.length === 2,
  );

  const secondResponse = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "重新开始", startNewConversation: true }),
  });
  assert.equal(secondResponse.status, 202);
  const secondRun = await secondResponse.json() as { sessionId: string };
  assert.notEqual(secondRun.sessionId, firstRun.sessionId);

  const state = await waitForRemoteState(
    server.url,
    (snapshot) =>
      snapshot.currentRun?.status === "completed" &&
      snapshot.currentRun.timeline.some((item) => item.kind === "final_answer") &&
      snapshot.lastSession?.messages.length === 2,
  );

  assert.equal(state.currentRun?.sessionId, secondRun.sessionId);
  assert.equal(state.lastSession?.id, secondRun.sessionId);
  assert.deepEqual(
    state.lastSession?.messages.map((message) => message.content),
    ["重新开始", "starting fresh -> 重新开始"],
  );
});

test("remote SSE stream delivers phased timeline events without final-answer streaming updates", async (t) => {
  const root = await createTempWorkspace("remote-sse", t);
  const sessionsDir = path.join(root, "sessions");
  const sessionStore = new SessionStore(sessionsDir);
  const service = new RemoteControlService({
    cwd: root,
    config: createRuntimeConfig(root, sessionsDir),
    sessionStore,
    writeTerminalLine: () => undefined,
    runTurn: async (options) => {
      const toolCall = createToolCall("tool-1", "read_file", { path: "README.md" });

      options.callbacks?.onModelWaitStart?.();
      options.callbacks?.onStatus?.("Reviewing the current plan");
      options.callbacks?.onReasoningDelta?.("Inspect current remote workflow.");
      await delay(15);
      options.callbacks?.onModelWaitStop?.();
      options.callbacks?.onToolCall?.("read_file", toolCall.function.arguments);
      await delay(15);
      options.callbacks?.onToolResult?.("read_file", JSON.stringify({ ok: true }, null, 2));
      await delay(15);
      options.callbacks?.onAssistantDelta?.("Phased");
      await delay(15);
      options.callbacks?.onAssistantDelta?.(" answer");
      options.callbacks?.onAssistantDone?.("Phased answer");

      const messages: StoredMessage[] = [
        createUserMessage(options.input),
        createAssistantMessage({
          reasoningContent: "Inspect current remote workflow.",
          toolCalls: [toolCall],
        }),
        createToolMessage("read_file", JSON.stringify({ ok: true }, null, 2)),
        createAssistantMessage({
          content: "Phased answer",
        }),
      ];
      const session = await options.sessionStore.appendMessages(options.session, messages);
      return {
        session,
        changedPaths: [],
        verificationAttempted: false,
        yielded: false,
      };
    },
  });
  const server = await startRemoteHttpServer({
    protocol: service,
    listenHost: "127.0.0.1",
    displayHost: "127.0.0.1",
    port: 0,
  });

  t.after(async () => {
    await service.stop();
    await server.stop();
  });

  const streamResponse = await fetch(`${server.url}/api/stream`, {
    headers: {
      Accept: "text/event-stream",
    },
  });
  assert.equal(streamResponse.status, 200);
  assert.equal(streamResponse.headers.get("content-type"), "text/event-stream; charset=utf-8");

  const eventPromise = collectRemoteStreamEvents(
    streamResponse,
    (events) =>
      events.some((event) => event.event === "snapshot") &&
      events.some((event) => event.event === "run" && event.data.run?.status === "running") &&
      events.some((event) => event.event === "timeline_add" && event.data.item?.kind === "reasoning") &&
      events.some((event) => event.event === "timeline_add" && event.data.item?.kind === "tool_use") &&
      events.some((event) => event.event === "timeline_update" && event.data.item?.kind === "tool_use") &&
      events.some((event) => event.event === "timeline_add" && event.data.item?.kind === "final_answer") &&
      events.some((event) => event.event === "run" && event.data.run?.status === "completed"),
  );

  const started = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "stream the current progress" }),
  });
  assert.equal(started.status, 202);

  const events = await eventPromise;
  assert.equal(events[0]?.event, "snapshot");
  assert.equal(events[0]?.id, 0);

  const finalAnswerUpdates = events.filter(
    (event) => event.event === "timeline_update" && event.data.item?.kind === "final_answer",
  );
  assert.equal(finalAnswerUpdates.length, 0);

  const finalAnswerAdds = events.filter(
    (event) => event.event === "timeline_add" && event.data.item?.kind === "final_answer",
  );
  assert.equal(finalAnswerAdds.length, 1);
  assert.match(JSON.stringify(finalAnswerAdds[0]?.data), /Phased answer/u);

  assert.ok(events.some((event) => event.event === "session"));
});

test("remote control can cancel the current run", async (t) => {
  const root = await createTempWorkspace("remote-cancel", t);
  const sessionsDir = path.join(root, "sessions");
  const sessionStore = new SessionStore(sessionsDir);
  const service = new RemoteControlService({
    cwd: root,
    config: createRuntimeConfig(root, sessionsDir),
    sessionStore,
    writeTerminalLine: () => undefined,
    runTurn: async (options) => {
      options.callbacks?.onStatus?.("Working");
      await options.sessionStore.appendMessages(options.session, [
        createUserMessage(options.input),
      ]);

      await new Promise<void>((resolve, reject) => {
        if (options.abortSignal?.aborted) {
          reject(createAbortError("Cancelled"));
          return;
        }

        const timer = setTimeout(resolve, 5_000);
        options.abortSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(createAbortError("Cancelled"));
          },
          { once: true },
        );
      });

      return {
        session: options.session,
        changedPaths: [],
        verificationAttempted: false,
        yielded: false,
      };
    },
  });
  const server = await startRemoteHttpServer({
    protocol: service,
    listenHost: "127.0.0.1",
    displayHost: "127.0.0.1",
    port: 0,
  });

  t.after(async () => {
    await service.stop();
    await server.stop();
  });

  await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "long task" }),
  });

  const cancelled = await fetch(`${server.url}/api/runs/current/cancel`, {
    method: "POST",
  });
  assert.equal(cancelled.status, 200);

  const state = await waitForRemoteState(
    server.url,
    (snapshot) => snapshot.currentRun?.status === "cancelled",
  );

  assert.equal(state.currentRun.status, "cancelled");
  assert.match(String(state.currentRun.error ?? ""), /cancelled by remote operator/i);
  assert.equal(state.currentRun.timeline.at(-1)?.kind, "warning");
});

function createToolCall(id: string, name: string, args: Record<string, unknown>): ToolCallRecord {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function createUserMessage(content: string): StoredMessage {
  return {
    role: "user",
    content,
    createdAt: new Date().toISOString(),
  };
}

function createAssistantMessage(options: {
  content?: string;
  reasoningContent?: string;
  toolCalls?: ToolCallRecord[];
}): StoredMessage {
  return {
    role: "assistant",
    content: options.content ?? "",
    reasoningContent: options.reasoningContent,
    tool_calls: options.toolCalls,
    createdAt: new Date().toISOString(),
  };
}

function createToolMessage(name: string, content: string): StoredMessage {
  return {
    role: "tool",
    name,
    content,
    createdAt: new Date().toISOString(),
  };
}

async function waitForRemoteState(
  baseUrl: string,
  predicate: (state: {
    currentRun: {
      sessionId: string;
      status: string;
      error?: string;
      timeline: Array<{ kind: string; text: string }>;
    } | null;
    lastSession: {
      id: string;
      messages: Array<{ content: string | null }>;
      timeline: Array<{ kind: string; text: string }>;
    } | null;
  }) => boolean,
): Promise<{
  currentRun: {
    sessionId: string;
    status: string;
    error?: string;
    timeline: Array<{ kind: string; text: string }>;
  };
  lastSession: {
    id: string;
    messages: Array<{ content: string | null }>;
    timeline: Array<{ kind: string; text: string }>;
  } | null;
}> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/state`);
    const state = (await response.json()) as {
      currentRun: {
        sessionId: string;
        status: string;
        error?: string;
        timeline: Array<{ kind: string; text: string }>;
      } | null;
      lastSession: {
        id: string;
        messages: Array<{ content: string | null }>;
        timeline: Array<{ kind: string; text: string }>;
      } | null;
    };

    if (predicate(state)) {
      return {
        currentRun: state.currentRun!,
        lastSession: state.lastSession,
      };
    }

    await delay(25);
  }

  throw new Error("Timed out waiting for remote state to settle.");
}

async function collectRemoteStreamEvents(
  response: Response,
  predicate: (events: Array<{ event: string; id: number | null; data: any }>) => boolean,
): Promise<Array<{ event: string; id: number | null; data: any }>> {
  assert.ok(response.body, "Expected a readable event stream body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; id: number | null; data: any }> = [];
  let buffer = "";
  const deadline = Date.now() + 5_000;

  try {
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        delay(200).then(() => ({ done: false, value: null as Uint8Array | null })),
      ]);

      if (result.done) {
        break;
      }

      if (result.value) {
        buffer += decoder.decode(result.value, { stream: true });
      }

      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";

      for (const part of parts) {
        const event = parseSseEvent(part);
        if (!event) {
          continue;
        }

        events.push(event);
        if (predicate(events)) {
          return events;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  throw new Error("Timed out waiting for remote SSE events.");
}

function parseSseEvent(chunk: string): { event: string; id: number | null; data: any } | null {
  if (!chunk.trim()) {
    return null;
  }

  let eventName = "message";
  let eventId: number | null = null;
  const dataLines: string[] = [];

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

  return {
    event: eventName,
    id: eventId,
    data: JSON.parse(dataLines.join("\n")),
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
