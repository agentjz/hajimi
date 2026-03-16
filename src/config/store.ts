import fs from "node:fs/promises";

import { loadDotEnvFiles } from "./env.js";
import { getDefaultMcpConfig, normalizeMcpConfig } from "../mcp/config.js";
import { getDefaultRemoteConfig, normalizeRemoteConfig } from "../remote/config.js";
import { getAppPaths } from "./paths.js";
import type { AgentMode, AppConfig, CliOverrides, RuntimeConfig } from "../types.js";

const DEFAULT_CONFIG: AppConfig = {
  provider: "deepseek",
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
  remote: getDefaultRemoteConfig(),
  mcp: getDefaultMcpConfig(),
};

export async function ensureAppDirectories(): Promise<ReturnType<typeof getAppPaths>> {
  const paths = getAppPaths();
  await fs.mkdir(paths.configDir, { recursive: true });
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.cacheDir, { recursive: true });
  await fs.mkdir(paths.sessionsDir, { recursive: true });
  await fs.mkdir(paths.changesDir, { recursive: true });
  return paths;
}

export function getDefaultConfig(): AppConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export async function loadConfig(): Promise<AppConfig> {
  const paths = await ensureAppDirectories();

  try {
    const raw = await fs.readFile(paths.configFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return normalizeConfig({ ...DEFAULT_CONFIG, ...parsed });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return getDefaultConfig();
    }
    throw error;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const paths = await ensureAppDirectories();
  const normalized = normalizeConfig(config);
  await fs.writeFile(paths.configFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export async function updateConfig(
  updater: (config: AppConfig) => AppConfig | Promise<AppConfig>,
): Promise<AppConfig> {
  const current = await loadConfig();
  const next = await updater(current);
  await saveConfig(next);
  return next;
}

export async function resolveRuntimeConfig(overrides: CliOverrides = {}): Promise<RuntimeConfig> {
  loadDotEnvFiles(overrides.cwd ?? process.cwd());
  const paths = await ensureAppDirectories();
  const fileConfig = await loadConfig();

  const merged = normalizeConfig({
    ...fileConfig,
    model: process.env.HAJIMI_MODEL ?? overrides.model ?? fileConfig.model,
    baseUrl: process.env.HAJIMI_BASE_URL ?? fileConfig.baseUrl,
    mode:
      parseAgentMode(process.env.HAJIMI_MODE) ??
      overrides.mode ??
      fileConfig.mode,
    remote: {
      ...fileConfig.remote,
      enabled: parseBooleanEnv(process.env.HAJIMI_REMOTE_ENABLED) ?? fileConfig.remote.enabled,
      host: process.env.HAJIMI_REMOTE_HOST ?? fileConfig.remote.host,
      port: parseNumberEnv(process.env.HAJIMI_REMOTE_PORT) ?? fileConfig.remote.port,
      bind: process.env.HAJIMI_REMOTE_BIND ?? fileConfig.remote.bind,
      publicUrl: process.env.HAJIMI_REMOTE_PUBLIC_URL ?? fileConfig.remote.publicUrl,
    },
    mcp: {
      ...fileConfig.mcp,
      enabled: parseBooleanEnv(process.env.HAJIMI_MCP_ENABLED) ?? fileConfig.mcp.enabled,
    },
  });

  const apiKey = process.env.HAJIMI_API_KEY ?? "";

  return {
    ...merged,
    apiKey,
    paths,
  };
}

export function parseAgentMode(value?: string): AgentMode | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "read-only") {
    return "read-only";
  }

  if (normalized === "agent") {
    return "agent";
  }

  return undefined;
}

function normalizeConfig(config: AppConfig): AppConfig {
  const allowedRoots =
    Array.isArray(config.allowedRoots) && config.allowedRoots.length > 0
      ? [...new Set(config.allowedRoots.map((value) => String(value).trim()).filter(Boolean))]
      : ["."];

  return {
    provider: "deepseek",
    baseUrl: config.baseUrl?.trim() || DEFAULT_CONFIG.baseUrl,
    model: config.model?.trim() || DEFAULT_CONFIG.model,
    mode: parseAgentMode(config.mode) ?? DEFAULT_CONFIG.mode,
    allowedRoots,
    yieldAfterToolSteps: clampNumber(
      config.yieldAfterToolSteps,
      0,
      50,
      DEFAULT_CONFIG.yieldAfterToolSteps,
    ),
    contextWindowMessages: clampNumber(config.contextWindowMessages, 6, 120, DEFAULT_CONFIG.contextWindowMessages),
    maxContextChars: clampNumber(config.maxContextChars, 8_000, 300_000, DEFAULT_CONFIG.maxContextChars),
    contextSummaryChars: clampNumber(
      config.contextSummaryChars,
      1_000,
      40_000,
      DEFAULT_CONFIG.contextSummaryChars,
    ),
    maxToolIterations: clampNumber(config.maxToolIterations, 1, 20, DEFAULT_CONFIG.maxToolIterations),
    maxContinuationBatches: clampNumber(
      config.maxContinuationBatches,
      1,
      20,
      DEFAULT_CONFIG.maxContinuationBatches,
    ),
    maxReadBytes: clampNumber(config.maxReadBytes, 2_000, 500_000, DEFAULT_CONFIG.maxReadBytes),
    maxSearchResults: clampNumber(config.maxSearchResults, 10, 500, DEFAULT_CONFIG.maxSearchResults),
    maxSpreadsheetPreviewRows: clampNumber(
      config.maxSpreadsheetPreviewRows,
      1,
      200,
      DEFAULT_CONFIG.maxSpreadsheetPreviewRows,
    ),
    maxSpreadsheetPreviewColumns: clampNumber(
      config.maxSpreadsheetPreviewColumns,
      1,
      100,
      DEFAULT_CONFIG.maxSpreadsheetPreviewColumns,
    ),
    commandStallTimeoutMs: clampNumber(config.commandStallTimeoutMs, 2_000, 300_000, DEFAULT_CONFIG.commandStallTimeoutMs),
    commandMaxRetries: clampNumber(config.commandMaxRetries, 0, 3, DEFAULT_CONFIG.commandMaxRetries),
    commandRetryBackoffMs: clampNumber(
      config.commandRetryBackoffMs,
      200,
      10_000,
      DEFAULT_CONFIG.commandRetryBackoffMs,
    ),
    showReasoning: Boolean(config.showReasoning),
    remote: normalizeRemoteConfig(config.remote),
    mcp: normalizeMcpConfig(config.mcp),
  };
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parseNumberEnv(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
