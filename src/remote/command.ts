import { SessionStore } from "../agent/sessionStore.js";
import { ui } from "../utils/console.js";
import { writeStdoutLine } from "../utils/stdio.js";
import type { RuntimeConfig } from "../types.js";
import { createRemoteTokenAuth } from "./auth.js";
import { createRemoteAccessToken, resolveRemoteListenHost } from "./config.js";
import { startRemoteHttpServer } from "./httpServer.js";
import { resolveRemoteDisplayHost } from "./network.js";
import { RemoteControlService } from "./service.js";

export interface RunRemoteModeOptions {
  cwd: string;
  config: RuntimeConfig;
}

export async function runRemoteMode(options: RunRemoteModeOptions): Promise<void> {
  if (!options.config.remote.enabled) {
    throw new Error("Remote mode is disabled. Set HAJIMI_REMOTE_ENABLED=true in .hajimi/.env to allow hajimi remote.");
  }

  const binding = resolveRemoteListenHost(options.config.remote.bind);
  const requestedHost = options.config.remote.host.trim();
  const displayHost = resolveRemoteDisplayHost({
    requestedHost,
    listenHost: binding.listenHost,
  });
  const accessToken = options.config.remote.token.trim() || createRemoteAccessToken();
  const sessionStore = new SessionStore(options.config.paths.sessionsDir);
  const protocol = new RemoteControlService({
    cwd: options.cwd,
    config: options.config,
    sessionStore,
  });
  const server = await startRemoteHttpServer({
    auth: createRemoteTokenAuth(accessToken),
    protocol,
    listenHost: binding.listenHost,
    displayHost,
    port: options.config.remote.port,
  });

  writeStdoutLine("Remote mode enabled.");
  writeStdoutLine("");
  writeStdoutLine("Open on your phone:");
  writeStdoutLine(server.url);
  writeStdoutLine("");
  writeStdoutLine("Access token:");
  writeStdoutLine(accessToken);
  writeStdoutLine("");
  writeStdoutLine("Use the token on first connect.");
  if (!requestedHost && displayHost !== "127.0.0.1" && binding.exposureKind !== "loopback") {
    ui.info(`Auto-detected LAN address: ${displayHost}`);
  }
  if (!options.config.apiKey) {
    ui.warn("HAJIMI_API_KEY is missing. The remote page will open, but runs will fail until the key is configured.");
  }
  if (displayHost === "127.0.0.1" && binding.exposureKind !== "loopback") {
    ui.warn("A LAN address was not detected automatically. Set HAJIMI_REMOTE_HOST in .hajimi/.env if your phone cannot reach this machine.");
  }
  if (options.config.remote.publicUrl.trim()) {
    ui.info(`Reserved public URL: ${options.config.remote.publicUrl.trim()}`);
  }
  writeStdoutLine("Press Ctrl+C to stop remote mode.");

  await waitForShutdown(async () => {
    await protocol.stop();
    await server.stop();
  });
}

async function waitForShutdown(onShutdown: () => Promise<void>): Promise<void> {
  let shuttingDown = false;

  await new Promise<void>((resolve, reject) => {
    const handleSignal = (signal: NodeJS.Signals): void => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      cleanup();
      onShutdown()
        .then(resolve)
        .catch(reject);
    };

    const cleanup = (): void => {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    };

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
  });
}
