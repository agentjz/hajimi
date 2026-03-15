import http from "node:http";
import type { AddressInfo } from "node:net";

import type { RemoteAuth } from "./auth.js";
import {
  renderRemoteControlAsset,
  renderRemoteControlPage,
  renderRemoteControlScript,
  renderRemoteControlStyles,
} from "./page.js";
import type { RemoteControlProtocol, RemoteStreamEvent } from "./types.js";

export interface RemoteHttpServerOptions {
  auth: RemoteAuth;
  protocol: RemoteControlProtocol;
  listenHost: string;
  displayHost: string;
  port: number;
  publicUrl?: string;
}

export interface RemoteHttpServerHandle {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export async function startRemoteHttpServer(options: RemoteHttpServerOptions): Promise<RemoteHttpServerHandle> {
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(options.port, options.listenHost, () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine remote server address.");
  }

  const actualPort = (address as AddressInfo).port;
  const url = options.publicUrl?.trim() || `http://${options.displayHost}:${actualPort}`;

  return {
    url,
    port: actualPort,
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: RemoteHttpServerOptions,
): Promise<void> {
  const method = request.method ?? "GET";
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

  try {
    if (method === "GET" && requestUrl.pathname === "/") {
      sendText(response, 200, "text/html; charset=utf-8", await renderRemoteControlPage());
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/assets/remote.css") {
      sendText(response, 200, "text/css; charset=utf-8", await renderRemoteControlStyles());
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/assets/remote.js") {
      sendText(response, 200, "text/javascript; charset=utf-8", await renderRemoteControlScript());
      return;
    }

    const assetMatch = requestUrl.pathname.match(/^\/assets\/(.+)$/);
    if (method === "GET" && assetMatch?.[1]) {
      const assetName = assetMatch[1];
      if (!isSafeAssetName(assetName)) {
        sendJson(response, 404, { ok: false, error: "Not found." });
        return;
      }

      sendText(response, 200, resolveAssetContentType(assetName), await renderRemoteControlAsset(assetName));
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/favicon.ico") {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (requestUrl.pathname.startsWith("/api/") && !options.auth.authorize(request)) {
      sendJson(response, 401, { ok: false, error: "Unauthorized. Provide a valid remote access token." });
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/api/state") {
      sendJson(response, 200, await options.protocol.getState());
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/api/stream") {
      await handleStreamRequest(request, response, options.protocol);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/runs") {
      const payload = await readJsonBody(request);
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      const run = await options.protocol.submitPrompt(prompt, {
        startNewConversation: payload.startNewConversation === true,
      });
      sendJson(response, 202, run);
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/api/runs/current/cancel") {
      const run = await options.protocol.cancelCurrentRun();
      sendJson(response, 200, {
        ok: true,
        run,
      });
      return;
    }

    const fileMatch = requestUrl.pathname.match(/^\/api\/files\/([^/]+)$/);
    if (method === "GET" && fileMatch?.[1]) {
      const file = await options.protocol.getSharedFile(decodeURIComponent(fileMatch[1]));
      if (!file) {
        sendJson(response, 404, { ok: false, error: "Shared file not found." });
        return;
      }

      sendDownload(response, file.fileName, file.contentType, file.content);
      return;
    }

    const sessionMatch = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (method === "GET" && sessionMatch?.[1]) {
      const session = await options.protocol.getSessionDetails(decodeURIComponent(sessionMatch[1]));
      if (!session) {
        sendJson(response, 404, { ok: false, error: "Session not found." });
        return;
      }

      sendJson(response, 200, session);
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = resolveStatusCode(message);
    sendJson(response, statusCode, {
      ok: false,
      error: message,
    });
  }
}

async function handleStreamRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  protocol: RemoteControlProtocol,
): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders?.();
  response.socket?.setKeepAlive(true, 15_000);

  const pendingEvents: RemoteStreamEvent[] = [];
  let closed = false;
  let ready = false;

  const unsubscribe = protocol.subscribe((event) => {
    if (closed) {
      return;
    }

    if (!ready) {
      pendingEvents.push(event);
      return;
    }

    writeRemoteEvent(response, event);
  });

  const cleanup = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    request.off("close", cleanup);
    response.off("close", cleanup);
    response.off("error", cleanup);
    if (!response.writableEnded) {
      response.end();
    }
  };

  const heartbeat = setInterval(() => {
    if (closed) {
      return;
    }

    try {
      response.write(": keep-alive\n\n");
    } catch {
      cleanup();
    }
  }, 15_000);

  request.on("close", cleanup);
  response.on("close", cleanup);
  response.on("error", cleanup);

  try {
    const state = await protocol.getState();
    writeSseMessage(response, "snapshot", { state }, state.streamCursor);
    ready = true;

    for (const event of pendingEvents) {
      if (event.id > state.streamCursor) {
        writeRemoteEvent(response, event);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeSseMessage(response, "error", { error: message });
    cleanup();
  }
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) {
      throw new Error("Request body is too large.");
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const body = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON body must be an object.");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid JSON body: ${(error as Error).message}`);
  }
}

function resolveStatusCode(message: string): number {
  const normalized = message.toLowerCase();
  if (normalized.includes("already running")) {
    return 409;
  }

  if (normalized.includes("cannot be empty") || normalized.includes("invalid json")) {
    return 400;
  }

  return 500;
}

function sendText(response: http.ServerResponse, statusCode: number, contentType: string, body: string): void {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendDownload(
  response: http.ServerResponse,
  fileName: string,
  contentType: string,
  content: Buffer,
): void {
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": content.length,
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="${encodeDownloadFileName(fileName)}"`,
  });
  response.end(content);
}

function encodeDownloadFileName(fileName: string): string {
  return fileName.replace(/["\r\n]/g, "_");
}

function isSafeAssetName(name: string): boolean {
  return !name.includes("..") && !name.startsWith("/") && !name.startsWith("\\");
}

function resolveAssetContentType(name: string): string {
  if (name.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (name.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (name.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  return "text/plain; charset=utf-8";
}

function writeRemoteEvent(response: http.ServerResponse, event: RemoteStreamEvent): void {
  writeSseMessage(response, event.payload.type, event.payload, event.id);
}

function writeSseMessage(
  response: http.ServerResponse,
  eventName: string,
  payload: unknown,
  id?: number,
): void {
  if (typeof id === "number") {
    response.write(`id: ${id}\n`);
  }

  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}
