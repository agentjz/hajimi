import path from "node:path";
import { spawn } from "node:child_process";

import type { RuntimeConfig } from "../types.js";

export interface SpawnTeammateProcessOptions {
  rootDir: string;
  config: RuntimeConfig;
  name: string;
  role: string;
  prompt: string;
}

export function spawnTeammateProcess(options: SpawnTeammateProcessOptions): number {
  const cliEntry = path.resolve(process.argv[1] ?? "");
  if (!cliEntry) {
    throw new Error("Unable to locate CLI entrypoint for teammate worker.");
  }

  const child = spawn(
    process.execPath,
    [
      cliEntry,
      "-C",
      options.rootDir,
      "--mode",
      options.config.mode,
      "--model",
      options.config.model,
      "__worker__",
      "teammate",
      "--name",
      options.name,
      "--role",
      options.role,
      "--prompt",
      options.prompt,
    ],
    {
      cwd: options.rootDir,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HAJIMI_API_KEY: options.config.apiKey,
        HAJIMI_BASE_URL: options.config.baseUrl,
        HAJIMI_MODEL: options.config.model,
        HAJIMI_MODE: options.config.mode,
      },
    },
  );

  child.unref();
  if (!child.pid) {
    throw new Error("Failed to spawn teammate worker process.");
  }

  return child.pid;
}
