#!/usr/bin/env node

import path from "node:path";

import { Command, InvalidOptionArgumentError } from "commander";
import { execa } from "execa";
import OpenAI from "openai";

import { runBackgroundWorker } from "./background/worker.js";
import { getErrorMessage } from "./agent/errors.js";
import { runManagedAgentTurn } from "./agent/managedTurn.js";
import { SessionStore } from "./agent/sessionStore.js";
import { ChangeStore } from "./changes/store.js";
import { initializeProjectFiles } from "./config/init.js";
import { loadConfig, parseAgentMode, resolveRuntimeConfig, updateConfig } from "./config/store.js";
import { runRemoteMode } from "./remote/command.js";
import { runTeammateWorker } from "./team/worker.js";
import type { AgentMode, AppConfig, CliOverrides, RuntimeConfig, SessionRecord } from "./types.js";
import { startInteractiveChat } from "./ui/interactive.js";
import { createStreamRenderer } from "./ui/streamRenderer.js";
import { ui } from "./utils/console.js";
import { tryParseJson } from "./utils/json.js";
import { installStdioGuards, writeStdoutLine } from "./utils/stdio.js";

async function main(): Promise<void> {
  installStdioGuards();
  const program = new Command();

  program
    .name("hajimi")
    .description("Hajimi - a terminal AI coding assistant.")
    .option("-m, --model <model>", "Override the configured model")
    .option(
      "--mode <mode>",
      "Mode: read-only | agent",
      (value: string) => {
        const parsed = parseAgentMode(value);
        if (!parsed) {
          throw new InvalidOptionArgumentError(`Invalid mode: ${value}`);
        }

        return parsed;
      },
    )
    .option("-C, --cwd <path>", "Working directory for this run")
    .argument("[prompt...]", "Start a new session with a one-shot prompt. Without a prompt, opens interactive chat.")
    .action(async (promptParts: string[]) => {
      const prompt = promptParts.join(" ").trim();
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));
      const sessionStore = new SessionStore(runtime.paths.sessionsDir);
      const session = await sessionStore.create(runtime.cwd);

      if (!prompt) {
        await startInteractiveChat({
          cwd: runtime.cwd,
          config: runtime.config,
          session,
          sessionStore,
        });
        return;
      }

      const nextSession = await runOneShotPrompt(prompt, runtime.cwd, runtime.config, session, sessionStore);
      ui.dim(`session: ${nextSession.id}`);
    });

  program
    .command("run")
    .description("Run a one-shot prompt in a new session.")
    .argument("<prompt...>", "Prompt to send")
    .action(async (promptParts: string[]) => {
      const prompt = promptParts.join(" ").trim();
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));
      const sessionStore = new SessionStore(runtime.paths.sessionsDir);
      const session = await sessionStore.create(runtime.cwd);
      const nextSession = await runOneShotPrompt(prompt, runtime.cwd, runtime.config, session, sessionStore);

      ui.dim(`session: ${nextSession.id}`);
    });

  program
    .command("resume")
    .description("Resume the latest session or a specific session id in interactive mode.")
    .argument("[sessionId]", "Session id")
    .action(async (sessionId: string | undefined) => {
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));
      const sessionStore = new SessionStore(runtime.paths.sessionsDir);
      const session = sessionId ? await sessionStore.load(sessionId) : await sessionStore.loadLatest();

      if (!session) {
        throw new Error("No saved sessions found.");
      }

      await startInteractiveChat({
        cwd: runtime.overrides.cwd ? runtime.cwd : session.cwd,
        config: runtime.config,
        session,
        sessionStore,
      });
    });

  program
    .command("sessions")
    .description("List recent sessions.")
    .option("-n, --limit <count>", "Number of sessions to show", (value) => Number.parseInt(value, 10), 20)
    .action(async (options: { limit?: number }) => {
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));
      const sessionStore = new SessionStore(runtime.paths.sessionsDir);
      const sessions = await sessionStore.list(options.limit ?? 20);

      if (sessions.length === 0) {
        ui.info("No saved sessions yet.");
        return;
      }

      for (const session of sessions) {
        writeStdoutLine(
          [
            session.id,
            session.updatedAt,
            session.title ?? "(untitled)",
            `messages=${session.messageCount}`,
          ].join("  "),
        );
      }
    });

  program
    .command("init")
    .description("Create local .env and .hajimiignore files in the current project.")
    .action(async () => {
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));
      const result = await initializeProjectFiles(runtime.cwd);

      if (result.created.length > 0) {
        ui.success(`Created ${result.created.length} file(s).`);
        for (const filePath of result.created) {
          writeStdoutLine(filePath);
        }
      }

      if (result.skipped.length > 0) {
        ui.info(`Skipped ${result.skipped.length} existing file(s).`);
        for (const filePath of result.skipped) {
          writeStdoutLine(filePath);
        }
      }
    });

  program
    .command("changes")
    .description("List recorded file changes, or show one change by id.")
    .argument("[changeId]", "Optional change id")
    .option("-n, --limit <count>", "Number of changes to show", (value) => Number.parseInt(value, 10), 20)
    .action(async (changeId: string | undefined, options: { limit?: number }) => {
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));
      const changeStore = new ChangeStore(runtime.paths.changesDir);

      if (changeId) {
        const change = await changeStore.load(changeId);
        writeStdoutLine(JSON.stringify(change, null, 2));
        return;
      }

      const changes = await changeStore.list(options.limit ?? 20);
      if (changes.length === 0) {
        ui.info("No recorded changes yet.");
        return;
      }

      for (const change of changes) {
        writeStdoutLine(
          [
            change.id,
            change.createdAt,
            change.toolName,
            `files=${change.operations.length}`,
            change.undoneAt ? "undone" : "active",
            truncateCliValue(change.summary, 80),
          ].join("  "),
        );
      }
    });

  program
    .command("undo")
    .description("Undo the latest recorded change or a specific change id.")
    .argument("[changeId]", "Optional change id")
    .action(async (changeId: string | undefined) => {
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));
      const changeStore = new ChangeStore(runtime.paths.changesDir);
      const result = await changeStore.undo(changeId);

      ui.success(`Undid ${result.record.id}`);
      for (const filePath of result.restoredPaths) {
        writeStdoutLine(filePath);
      }
    });

  program
    .command("diff")
    .description("Show current git diff in this project, or only for one path.")
    .argument("[target]", "Optional file path")
    .action(async (target: string | undefined) => {
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));
      const result = await execa("git", target ? ["diff", "--", target] : ["diff"], {
        cwd: runtime.cwd,
        all: true,
        reject: false,
      });

      if ((result.exitCode ?? 0) > 1) {
        throw new Error(result.all || "git diff failed.");
      }

      const output = result.all?.trim();
      writeStdoutLine(output ? output : "No diff.");
    });

  const configCommand = program.command("config").description("Read or update Hajimi config.");

  configCommand
    .command("show")
    .description("Show config file values and API key status.")
    .action(async () => {
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));
      const config = await loadConfig();
      writeStdoutLine(
        JSON.stringify(
          {
            ...config,
            apiKey: runtime.config.apiKey ? "set" : "missing",
            configFile: runtime.paths.configFile,
            sessionsDir: runtime.paths.sessionsDir,
            changesDir: runtime.paths.changesDir,
          },
          null,
          2,
        ),
      );
    });

  configCommand
    .command("path")
    .description("Show the config file path.")
    .action(async () => {
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));
      writeStdoutLine(runtime.paths.configFile);
    });

  configCommand
    .command("get")
    .description("Read a config key.")
    .argument("<key>", "Config key")
    .action(async (key: keyof AppConfig) => {
      const config = await loadConfig();
      if (!(key in config)) {
        throw new Error(`Unknown config key: ${key}`);
      }

      writeStdoutLine(JSON.stringify(config[key], null, 2));
    });

  configCommand
    .command("set")
    .description("Set a config key. Arrays can be JSON or comma-separated.")
    .argument("<key>", "Config key")
    .argument("<value>", "Config value")
    .action(async (key: keyof AppConfig, value: string) => {
      const next = await updateConfig((config) => {
        if (!(key in config)) {
          throw new Error(`Unknown config key: ${key}`);
        }

        return {
          ...config,
          [key]: coerceConfigValue(key, value),
        } as AppConfig;
      });

      ui.success(`Updated ${key}`);
      writeStdoutLine(JSON.stringify(next[key], null, 2));
    });

  program
    .command("doctor")
    .description("Check local setup and validate the API connection.")
    .action(async () => {
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));

      ui.info(`config: ${runtime.paths.configFile}`);
      ui.info(`sessions: ${runtime.paths.sessionsDir}`);
      ui.info(`model: ${runtime.config.model}`);
      ui.info(`baseUrl: ${runtime.config.baseUrl}`);
      ui.info(`mode: ${runtime.config.mode}`);

      if (!runtime.config.apiKey) {
        ui.warn("No API key found. Update the .env file first.");
        return;
      }

      const client = new OpenAI({
        apiKey: runtime.config.apiKey,
        baseURL: runtime.config.baseUrl,
      });

      const models = await client.models.list();
      const count = Array.isArray(models.data) ? models.data.length : 0;
      ui.success(`API reachable. models=${count}`);
    });

  program
    .command("remote")
    .description("Expose a token-gated LAN control page for this Hajimi project.")
    .action(async () => {
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));
      await runRemoteMode({
        cwd: runtime.cwd,
        config: runtime.config,
      });
    });

  const workerCommand = program.command("__worker__");

  workerCommand
    .command("background")
    .requiredOption("--job-id <jobId>", "Background job id")
    .action(async (options: { jobId: string }) => {
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));
      await runBackgroundWorker({
        rootDir: runtime.cwd,
        jobId: options.jobId,
      });
    });

  workerCommand
    .command("teammate")
    .requiredOption("--name <name>", "Teammate name")
    .requiredOption("--role <role>", "Teammate role")
    .requiredOption("--prompt <prompt>", "Initial teammate prompt")
    .action(async (options: { name: string; role: string; prompt: string }) => {
      const runtime = await resolveRuntime(extractCliOverrides(program.opts()));
      await runTeammateWorker({
        rootDir: runtime.cwd,
        config: runtime.config,
        name: options.name,
        role: options.role,
        prompt: options.prompt,
      });
    });

  await program.parseAsync(process.argv);
}

void main().catch((error: unknown) => {
  ui.error(getErrorMessage(error));
  process.exitCode = 1;
});

async function resolveRuntime(overrides: CliOverrides): Promise<{
  cwd: string;
  config: RuntimeConfig;
  paths: RuntimeConfig["paths"];
  overrides: CliOverrides;
}> {
  const cwd = overrides.cwd ? path.resolve(overrides.cwd) : process.cwd();
  const config = await resolveRuntimeConfig({
    cwd,
    model: overrides.model,
    mode: normalizeModeOverride(overrides.mode),
  });

  return {
    cwd,
    config,
    paths: config.paths,
    overrides,
  };
}

function normalizeModeOverride(value: string | AgentMode | undefined): AgentMode | undefined {
  return typeof value === "string" ? parseAgentMode(value) : value;
}

async function runOneShotPrompt(
  prompt: string,
  cwd: string,
  config: RuntimeConfig,
  session: SessionRecord,
  sessionStore: SessionStore,
): Promise<SessionRecord> {
  const streamRenderer = createStreamRenderer(config, {
    cwd,
    assistantLeadingBlankLine: false,
    assistantTrailingNewlines: "\n",
    reasoningLeadingBlankLine: false,
    toolArgsMaxChars: 160,
    toolErrorLabel: "failed, model will try another path",
  });

  try {
    const result = await runManagedAgentTurn({
      input: prompt,
      cwd,
      config,
      session,
      sessionStore,
      callbacks: streamRenderer.callbacks,
      identity: {
        kind: "lead",
        name: "lead",
      },
    });
    if (result.paused && result.pauseReason) {
      ui.warn(result.pauseReason);
    }
    return result.session;
  } catch (error) {
    streamRenderer.flush();
    throw error;
  }
}

function coerceConfigValue(key: keyof AppConfig, rawValue: string): AppConfig[keyof AppConfig] {
  switch (key) {
    case "allowedRoots": {
      const parsed = tryParseJson(rawValue);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item)) as AppConfig[keyof AppConfig];
      }

      return rawValue
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean) as AppConfig[keyof AppConfig];
    }
    case "showReasoning":
      return (rawValue === "true" || rawValue === "1") as AppConfig[keyof AppConfig];
    case "contextWindowMessages":
    case "maxContextChars":
    case "contextSummaryChars":
    case "yieldAfterToolSteps":
    case "maxToolIterations":
    case "maxContinuationBatches":
    case "maxReadBytes":
    case "maxSearchResults":
    case "maxSpreadsheetPreviewRows":
    case "maxSpreadsheetPreviewColumns":
    case "commandStallTimeoutMs":
    case "commandMaxRetries":
    case "commandRetryBackoffMs": {
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Expected a number for ${key}.`);
      }

      return parsed as AppConfig[keyof AppConfig];
    }
    case "mode": {
      const parsed = parseAgentMode(rawValue);
      if (!parsed) {
        throw new Error(`Invalid mode: ${rawValue}`);
      }

      return parsed as AppConfig[keyof AppConfig];
    }
    case "provider":
      return "deepseek" as AppConfig[keyof AppConfig];
    case "remote":
    case "mcp": {
      const parsed = tryParseJson(rawValue);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Expected a JSON object for ${key}.`);
      }

      return parsed as AppConfig[keyof AppConfig];
    }
    default:
      return rawValue as AppConfig[keyof AppConfig];
  }
}

function extractCliOverrides(options: Record<string, unknown>): CliOverrides {
  return {
    cwd: typeof options.cwd === "string" ? options.cwd : undefined,
    model: typeof options.model === "string" ? options.model : undefined,
    mode: normalizeModeOverride(typeof options.mode === "string" ? options.mode : (options.mode as AgentMode | undefined)),
  };
}

function truncateCliValue(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...`;
}
