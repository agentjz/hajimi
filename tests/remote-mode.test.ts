import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/agent/sessionStore.js";
import { ChangeStore } from "../src/changes/store.js";
import { resolveRuntimeConfig } from "../src/config/store.js";
import { loadProjectContext } from "../src/context/projectContext.js";
import { createRemoteTokenAuth } from "../src/remote/auth.js";
import { startRemoteHttpServer } from "../src/remote/httpServer.js";
import { RemoteControlService } from "../src/remote/service.js";
import { createToolRegistry } from "../src/tools/index.js";
import type { RuntimeConfig, StoredMessage, ToolCallRecord, ToolExecutionResult } from "../src/types.js";
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
      token: "token-1234",
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
      "HAJIMI_REMOTE_TOKEN=alpha-token",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(rootB, ".hajimi", ".env"),
    [
      "HAJIMI_API_KEY=test-b",
      "HAJIMI_REMOTE_PORT=5102",
      "HAJIMI_REMOTE_TOKEN=beta-token",
    ].join("\n"),
    "utf8",
  );

  const configA = await resolveRuntimeConfig({ cwd: rootA });
  const configB = await resolveRuntimeConfig({ cwd: rootB });

  assert.equal(configA.remote.port, 5101);
  assert.equal(configA.remote.token, "alpha-token");
  assert.equal(configB.remote.port, 5102);
  assert.equal(configB.remote.token, "beta-token");
});

test("remote HTTP page serves split assets and renders phased chat state", async (t) => {
  const root = await createTempWorkspace("remote-http", t);
  const sessionsDir = path.join(root, "sessions");
  const sessionStore = new SessionStore(sessionsDir);
  const service = new RemoteControlService({
    cwd: root,
    config: createRuntimeConfig(root, sessionsDir),
    sessionStore,
    runTurn: async (options) => {
      options.callbacks?.onModelWaitStart?.();
      options.callbacks?.onStatus?.("Planning the remote task");
      options.callbacks?.onReasoningDelta?.("Inspecting the repository before replying.");
      options.callbacks?.onModelWaitStop?.();
      options.callbacks?.onAssistantDelta?.("Remote task");
      options.callbacks?.onAssistantDelta?.(" output");
      options.callbacks?.onAssistantDone?.("Remote task output");

      const messages: StoredMessage[] = [
        {
          role: "user",
          content: options.input,
          createdAt: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: "Remote task output",
          reasoningContent: "Inspecting the repository before replying.",
          createdAt: new Date().toISOString(),
        },
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
    auth: createRemoteTokenAuth("token-1234"),
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
  assert.match(page, /哈基米聊天/u);
  assert.match(page, /新建对话/u);
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

  const unauthorized = await fetch(`${server.url}/api/state`);
  assert.equal(unauthorized.status, 401);

  const unauthorizedStream = await fetch(`${server.url}/api/stream`);
  assert.equal(unauthorizedStream.status, 401);

  const started = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      Authorization: "Bearer token-1234",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "inspect the project" }),
  });
  assert.equal(started.status, 202);

  const state = await waitForRemoteState(
    server.url,
    "token-1234",
    (snapshot) => snapshot.currentRun?.status === "completed",
  );

  assert.equal(state.currentRun.status, "completed");
  assert.match(String(state.currentRun.assistantPreview ?? ""), /Remote task output/);
  assert.equal(state.recentSessions.length, 1);
  assert.equal(state.lastSession?.messages.at(-1)?.content, "Remote task output");
  assert.equal(state.lastSession?.timeline.at(-1)?.kind, "final_answer");
  assert.equal(state.currentRun.timeline[0]?.kind, "user");
  assert.equal(state.currentRun.timeline.at(-1)?.kind, "status");
});

test("remote keeps the same session and timeline when the next message continues the chat", async (t) => {
  const root = await createTempWorkspace("remote-continuation", t);
  const sessionsDir = path.join(root, "sessions");
  const sessionStore = new SessionStore(sessionsDir);
  const service = new RemoteControlService({
    cwd: root,
    config: createRuntimeConfig(root, sessionsDir),
    sessionStore,
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
        {
          role: "user",
          content: options.input,
          createdAt: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: answer,
          createdAt: new Date().toISOString(),
        },
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
    auth: createRemoteTokenAuth("token-1234"),
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
      Authorization: "Bearer token-1234",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "第一句" }),
  });
  assert.equal(firstResponse.status, 202);
  const firstRun = await firstResponse.json() as { sessionId: string };

  await waitForRemoteState(
    server.url,
    "token-1234",
    (snapshot) => snapshot.currentRun?.status === "completed" && snapshot.recentSessions.length === 1,
  );

  const secondResponse = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      Authorization: "Bearer token-1234",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "第二句" }),
  });
  assert.equal(secondResponse.status, 202);
  const secondRun = await secondResponse.json() as { sessionId: string };
  assert.equal(secondRun.sessionId, firstRun.sessionId);

  await waitForRemoteState(
    server.url,
    "token-1234",
    (snapshot) => snapshot.currentRun?.status === "completed" && snapshot.lastSession?.messages.length === 4,
  );

  const stateResponse = await fetch(`${server.url}/api/state`, {
    headers: {
      Authorization: "Bearer token-1234",
    },
  });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json() as {
    currentRun: {
      sessionId: string;
      timeline: Array<{ kind: string; text: string }>;
    } | null;
    lastSession: {
      id: string;
      messages: Array<{ content: string | null }>;
    } | null;
  };

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
        {
          role: "user",
          content: options.input,
          createdAt: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: answer,
          createdAt: new Date().toISOString(),
        },
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
    auth: createRemoteTokenAuth("token-1234"),
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
      Authorization: "Bearer token-1234",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "第一句" }),
  });
  assert.equal(firstResponse.status, 202);
  const firstRun = await firstResponse.json() as { sessionId: string };

  await waitForRemoteState(
    server.url,
    "token-1234",
    (snapshot) => snapshot.currentRun?.status === "completed" && snapshot.recentSessions.length === 1,
  );

  const secondResponse = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      Authorization: "Bearer token-1234",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "重新开始", startNewConversation: true }),
  });
  assert.equal(secondResponse.status, 202);
  const secondRun = await secondResponse.json() as { sessionId: string };
  assert.notEqual(secondRun.sessionId, firstRun.sessionId);

  await waitForRemoteState(
    server.url,
    "token-1234",
    (snapshot) =>
      snapshot.currentRun?.status === "completed" &&
      snapshot.currentRun.timeline.some((item) => item.kind === "final_answer") &&
      snapshot.recentSessions.length === 2 &&
      snapshot.lastSession?.messages.length === 2,
  );

  const stateResponse = await fetch(`${server.url}/api/state`, {
    headers: {
      Authorization: "Bearer token-1234",
    },
  });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json() as {
    currentRun: {
      sessionId: string;
      timeline: Array<{ kind: string; text: string }>;
    } | null;
    recentSessions: Array<{ id: string }>;
    lastSession: {
      id: string;
      messages: Array<{ content: string | null }>;
    } | null;
  };

  assert.equal(state.currentRun?.sessionId, secondRun.sessionId);
  assert.equal(state.lastSession?.id, secondRun.sessionId);
  assert.equal(state.recentSessions.length, 2);
  assert.deepEqual(
    state.lastSession?.messages.map((message) => message.content),
    ["重新开始", "starting fresh -> 重新开始"],
  );
  assert.match(
    String(state.currentRun?.timeline.filter((item) => item.kind === "final_answer").at(-1)?.text ?? ""),
    /starting fresh -> 重新开始/u,
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
    runTurn: async (options) => {
      const toolCall: ToolCallRecord = {
        id: "tool-1",
        type: "function",
        function: {
          name: "todo_write",
          arguments: JSON.stringify({
            items: [
              { id: "1", text: "Inspect remote flow", status: "completed" },
              { id: "2", text: "Render phased cards", status: "in_progress" },
            ],
          }),
        },
      };

      options.callbacks?.onModelWaitStart?.();
      options.callbacks?.onStatus?.("Reviewing the todo plan");
      options.callbacks?.onReasoningDelta?.("Inspect current remote workflow.");
      await delay(15);
      options.callbacks?.onModelWaitStop?.();
      options.callbacks?.onToolCall?.("todo_write", toolCall.function.arguments);
      await delay(15);
      options.callbacks?.onToolResult?.(
        "todo_write",
        JSON.stringify(
          {
            ok: true,
            items: [
              { id: "1", text: "Inspect remote flow", status: "completed" },
              { id: "2", text: "Render phased cards", status: "in_progress" },
            ],
            total: 2,
            completed: 1,
            inProgress: "2",
          },
          null,
          2,
        ),
      );
      await delay(15);
      options.callbacks?.onAssistantDelta?.("Phased");
      await delay(15);
      options.callbacks?.onAssistantDelta?.(" answer");
      options.callbacks?.onAssistantDone?.("Phased answer");

      const messages: StoredMessage[] = [
        {
          role: "user",
          content: options.input,
          createdAt: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: "",
          reasoningContent: "Inspect current remote workflow.",
          tool_calls: [toolCall],
          createdAt: new Date().toISOString(),
        },
        {
          role: "tool",
          name: "todo_write",
          content: JSON.stringify(
            {
              ok: true,
              items: [
                { id: "1", text: "Inspect remote flow", status: "completed" },
                { id: "2", text: "Render phased cards", status: "in_progress" },
              ],
            },
            null,
            2,
          ),
          createdAt: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: "Phased answer",
          createdAt: new Date().toISOString(),
        },
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
    auth: createRemoteTokenAuth("token-1234"),
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
      Authorization: "Bearer token-1234",
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
      events.some((event) => event.event === "timeline_add" && event.data.item?.kind === "todo") &&
      events.some((event) => event.event === "timeline_add" && event.data.item?.kind === "final_answer") &&
      events.some((event) => event.event === "run" && event.data.run?.status === "completed"),
  );

  const started = await fetch(`${server.url}/api/runs`, {
    method: "POST",
    headers: {
      Authorization: "Bearer token-1234",
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

test("remote file sharing creates a downloadable snapshot by share id", async (t) => {
  const root = await createTempWorkspace("remote-share", t);
  await fs.writeFile(path.join(root, "shared.txt"), "first version", "utf8");

  const sessionsDir = path.join(root, "sessions");
  const config = createRuntimeConfig(root, sessionsDir);
  const sessionStore = new SessionStore(sessionsDir);
  const service = new RemoteControlService({
    cwd: root,
    config,
    sessionStore,
    runTurn: async (options) => {
      const toolCall: ToolCallRecord = {
        id: "tool-share-1",
        type: "function",
        function: {
          name: "remote_share_file",
          arguments: JSON.stringify({ path: "shared.txt" }),
        },
      };

      options.callbacks?.onToolCall?.("remote_share_file", toolCall.function.arguments);
      const toolOutput = await executeToolForTest(options, toolCall.function.name, toolCall.function.arguments);
      options.callbacks?.onToolResult?.("remote_share_file", toolOutput);

      await fs.writeFile(path.join(root, "shared.txt"), "second version", "utf8");
      options.callbacks?.onAssistantDone?.("I shared the file.");

      const messages: StoredMessage[] = [
        {
          role: "user",
          content: options.input,
          createdAt: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [toolCall],
          createdAt: new Date().toISOString(),
        },
        {
          role: "tool",
          name: "remote_share_file",
          content: toolOutput,
          createdAt: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: "I shared the file.",
          createdAt: new Date().toISOString(),
        },
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
    auth: createRemoteTokenAuth("token-1234"),
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
      Authorization: "Bearer token-1234",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "share the file with me" }),
  });
  assert.equal(started.status, 202);

  const state = await waitForRemoteState(
    server.url,
    "token-1234",
    (snapshot) =>
      snapshot.currentRun?.status === "completed" &&
      snapshot.currentRun.timeline.some((item) => item.kind === "file_share"),
  );

  const sharedItem = state.currentRun.timeline.find((item) => item.kind === "file_share");
  assert.ok(sharedItem?.file?.shareId);
  assert.equal(sharedItem?.file?.fileName, "shared.txt");
  assert.equal(state.lastSession?.timeline.some((item) => item.kind === "file_share"), true);

  const download = await fetch(`${server.url}/api/files/${sharedItem.file.shareId}`, {
    headers: {
      Authorization: "Bearer token-1234",
    },
  });
  assert.equal(download.status, 200);
  assert.match(String(download.headers.get("content-disposition")), /shared\.txt/);
  assert.equal(await download.text(), "first version");
});

test("remote auto-shares the final generated document as a downloadable file card", async (t) => {
  const root = await createTempWorkspace("remote-auto-share", t);
  const sessionsDir = path.join(root, "sessions");
  const config = createRuntimeConfig(root, sessionsDir);
  const sessionStore = new SessionStore(sessionsDir);
  const service = new RemoteControlService({
    cwd: root,
    config,
    sessionStore,
    runTurn: async (options) => {
      const writeCall: ToolCallRecord = {
        id: "tool-write-1",
        type: "function",
        function: {
          name: "write_file",
          arguments: JSON.stringify({
            path: "docs/report.md",
            content: "# Report\n\ndraft version",
          }),
        },
      };
      const editCall: ToolCallRecord = {
        id: "tool-edit-1",
        type: "function",
        function: {
          name: "edit_file",
          arguments: JSON.stringify({
            path: "docs/report.md",
            old_string: "draft version",
            new_string: "final version",
          }),
        },
      };

      options.callbacks?.onToolCall?.("write_file", writeCall.function.arguments);
      const writeResult = await executeToolForTestDetailed(options, writeCall.function.name, writeCall.function.arguments);
      options.callbacks?.onToolResult?.("write_file", writeResult.output);

      options.callbacks?.onToolCall?.("edit_file", editCall.function.arguments);
      const editResult = await executeToolForTestDetailed(options, editCall.function.name, editCall.function.arguments);
      options.callbacks?.onToolResult?.("edit_file", editResult.output);

      options.callbacks?.onAssistantDone?.("The document is ready.");

      const messages: StoredMessage[] = [
        {
          role: "user",
          content: options.input,
          createdAt: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [writeCall],
          createdAt: new Date().toISOString(),
        },
        {
          role: "tool",
          name: "write_file",
          content: writeResult.output,
          createdAt: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [editCall],
          createdAt: new Date().toISOString(),
        },
        {
          role: "tool",
          name: "edit_file",
          content: editResult.output,
          createdAt: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: "The document is ready.",
          createdAt: new Date().toISOString(),
        },
      ];
      const session = await options.sessionStore.appendMessages(options.session, messages);
      return {
        session,
        changedPaths: [
          ...(writeResult.metadata?.changedPaths ?? []),
          ...(editResult.metadata?.changedPaths ?? []),
        ],
        verificationAttempted: false,
        yielded: false,
      };
    },
  });
  const server = await startRemoteHttpServer({
    auth: createRemoteTokenAuth("token-1234"),
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
      Authorization: "Bearer token-1234",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "create a report and send it to my phone" }),
  });
  assert.equal(started.status, 202);

  const state = await waitForRemoteState(
    server.url,
    "token-1234",
    (snapshot) =>
      snapshot.currentRun?.status === "completed" &&
      snapshot.currentRun.timeline.filter((item) => item.kind === "file_share").length === 1 &&
      snapshot.lastSession?.timeline.some((item) => item.kind === "file_share") === true,
  );

  const sharedItem = state.currentRun.timeline.find((item) => item.kind === "file_share");
  assert.equal(sharedItem?.file?.fileName, "report.md");
  assert.equal(sharedItem?.file?.relativePath, "docs/report.md");
  assert.equal(state.lastSession?.timeline.filter((item) => item.kind === "file_share").length, 1);

  const download = await fetch(`${server.url}/api/files/${sharedItem?.file?.shareId}`, {
    headers: {
      Authorization: "Bearer token-1234",
    },
  });
  assert.equal(download.status, 200);
  assert.match(String(download.headers.get("content-disposition")), /report\.md/);
  assert.equal(await download.text(), "# Report\n\nfinal version");
});

test("remote control can cancel the current run", async (t) => {
  const root = await createTempWorkspace("remote-cancel", t);
  const sessionsDir = path.join(root, "sessions");
  const sessionStore = new SessionStore(sessionsDir);
  const service = new RemoteControlService({
    cwd: root,
    config: createRuntimeConfig(root, sessionsDir),
    sessionStore,
    runTurn: async (options) => {
      options.callbacks?.onStatus?.("Working");
      await options.sessionStore.appendMessages(options.session, [
        {
          role: "user",
          content: options.input,
          createdAt: new Date().toISOString(),
        },
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
    auth: createRemoteTokenAuth("token-1234"),
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
      Authorization: "Bearer token-1234",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "long task" }),
  });

  const cancelled = await fetch(`${server.url}/api/runs/current/cancel`, {
    method: "POST",
    headers: {
      Authorization: "Bearer token-1234",
    },
  });
  assert.equal(cancelled.status, 200);

  const state = await waitForRemoteState(
    server.url,
    "token-1234",
    (snapshot) => snapshot.currentRun?.status === "cancelled",
  );

  assert.equal(state.currentRun.status, "cancelled");
  assert.match(String(state.currentRun.error ?? ""), /cancelled by remote operator/i);
  assert.equal(state.currentRun.timeline.at(-1)?.kind, "warning");
});

async function executeToolForTest(
  options: {
    toolRegistry?: {
      execute: (
        name: string,
        rawArgs: string,
        context: {
          config: RuntimeConfig;
          cwd: string;
          sessionId: string;
          identity: { kind: "lead"; name: "lead" };
          projectContext: Awaited<ReturnType<typeof loadProjectContext>>;
          changeStore: ChangeStore;
          createToolRegistry: typeof createToolRegistry;
        },
      ) => Promise<ToolExecutionResult>;
    };
    config: RuntimeConfig;
    cwd: string;
    session: { id: string };
  },
  name: string,
  rawArgs: string,
): Promise<string> {
  const result = await executeToolForTestDetailed(options, name, rawArgs);
  return result.output;
}

async function executeToolForTestDetailed(
  options: {
    toolRegistry?: {
      execute: (
        name: string,
        rawArgs: string,
        context: {
          config: RuntimeConfig;
          cwd: string;
          sessionId: string;
          identity: { kind: "lead"; name: "lead" };
          projectContext: Awaited<ReturnType<typeof loadProjectContext>>;
          changeStore: ChangeStore;
          createToolRegistry: typeof createToolRegistry;
        },
      ) => Promise<ToolExecutionResult>;
    };
    config: RuntimeConfig;
    cwd: string;
    session: { id: string };
  },
  name: string,
  rawArgs: string,
): Promise<ToolExecutionResult> {
  assert.ok(options.toolRegistry, "Expected a tool registry from remote service.");

  const projectContext = await loadProjectContext(options.cwd);
  const changeStore = new ChangeStore(options.config.paths.changesDir);
  return options.toolRegistry.execute(name, rawArgs, {
    config: options.config,
    cwd: options.cwd,
    sessionId: options.session.id,
    identity: {
      kind: "lead",
      name: "lead",
    },
    projectContext,
    changeStore,
    createToolRegistry,
  });
}

async function waitForRemoteState(
  baseUrl: string,
  token: string,
  predicate: (state: {
    currentRun: {
      status: string;
      error?: string;
      assistantPreview?: string;
      timeline: Array<{ kind: string; file?: { shareId?: string; fileName?: string; relativePath?: string } }>;
    } | null;
    recentSessions: Array<{ id: string }>;
    lastSession: {
      messages: Array<{ content: string | null }>;
      timeline: Array<{ kind: string; file?: { shareId?: string; fileName?: string; relativePath?: string } }>;
    } | null;
  }) => boolean,
): Promise<{
  currentRun: {
    status: string;
    error?: string;
    assistantPreview?: string;
    timeline: Array<{ kind: string; file?: { shareId?: string; fileName?: string; relativePath?: string } }>;
  };
  recentSessions: Array<{ id: string }>;
  lastSession: {
    messages: Array<{ content: string | null }>;
    timeline: Array<{ kind: string; file?: { shareId?: string; fileName?: string; relativePath?: string } }>;
  } | null;
}> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/state`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const state = (await response.json()) as {
      currentRun: {
        status: string;
        error?: string;
        assistantPreview?: string;
        timeline: Array<{ kind: string; file?: { shareId?: string; fileName?: string; relativePath?: string } }>;
      } | null;
      recentSessions: Array<{ id: string }>;
      lastSession: {
        messages: Array<{ content: string | null }>;
        timeline: Array<{ kind: string; file?: { shareId?: string; fileName?: string; relativePath?: string } }>;
      } | null;
    };

    if (predicate(state)) {
      return {
        currentRun: state.currentRun!,
        recentSessions: state.recentSessions,
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
