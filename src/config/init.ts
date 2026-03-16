import fs from "node:fs/promises";
import path from "node:path";

import { getDefaultHajimiIgnoreContent } from "../utils/ignore.js";

export interface InitProjectResult {
  created: string[];
  skipped: string[];
}

export async function initializeProjectFiles(cwd: string): Promise<InitProjectResult> {
  const created: string[] = [];
  const skipped: string[] = [];

  const hajimiDir = path.join(cwd, ".hajimi");
  const envPath = path.join(hajimiDir, ".env");
  const ignorePath = path.join(hajimiDir, ".hajimiignore");

  // Ensure .hajimi directory exists
  await fs.mkdir(hajimiDir, { recursive: true });

  if (await fileExists(envPath)) {
    skipped.push(envPath);
  } else {
    await fs.writeFile(
      envPath,
      [
        "# Hajimi env template",
        "# Keep only one active provider/model block below.",
        "# The variable names are HAJIMI_* for compatibility, but baseUrl/model can point to other OpenAI-compatible providers.",
        "",
        "# Active default: SiliconFlow + DeepSeek V3.2",
        "HAJIMI_API_KEY=replace-with-your-key",
        "HAJIMI_BASE_URL=https://api.siliconflow.cn/v1",
        "HAJIMI_MODEL=deepseek-ai/DeepSeek-V3.2",
        "",
        "# Backup example: DeepSeek official",
        "# HAJIMI_API_KEY=replace-with-your-key",
        "# HAJIMI_BASE_URL=https://api.deepseek.com",
        "# HAJIMI_MODEL=deepseek-reasoner",
        "",
        "# Backup example: SiliconFlow + MiniMax M2.5",
        "# HAJIMI_API_KEY=replace-with-your-key",
        "# HAJIMI_BASE_URL=https://api.siliconflow.cn/v1",
        "# HAJIMI_MODEL=Pro/MiniMaxAI/MiniMax-M2.5",
        "",
        "# Backup example: SiliconFlow + Kimi K2.5",
        "# HAJIMI_API_KEY=replace-with-your-key",
        "# HAJIMI_BASE_URL=https://api.siliconflow.cn/v1",
        "# HAJIMI_MODEL=Pro/moonshotai/Kimi-K2.5",
        "",
        "# Remote mode defaults for hajimi remote",
        "HAJIMI_REMOTE_ENABLED=true",
        "HAJIMI_REMOTE_BIND=lan",
        "HAJIMI_REMOTE_PORT=4387",
        "# Leave blank to auto-detect a LAN address at startup.",
        "# HAJIMI_REMOTE_HOST=",
        "# HAJIMI_REMOTE_PUBLIC_URL=",
        "",
      ].join("\n"),
      "utf8",
    );
    created.push(envPath);
  }

  if (await fileExists(ignorePath)) {
    skipped.push(ignorePath);
  } else {
    await fs.writeFile(ignorePath, getDefaultHajimiIgnoreContent(), "utf8");
    created.push(ignorePath);
  }

  return {
    created,
    skipped,
  };
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
