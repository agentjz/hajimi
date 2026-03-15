import fs from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";

import type { LoadedSkill, ProjectIgnoreRule } from "../types.js";
import { isPathIgnored } from "../utils/ignore.js";

export async function discoverSkills(
  rootDir: string,
  cwd: string,
  ignoreRules: ProjectIgnoreRule[],
): Promise<LoadedSkill[]> {
  const candidateRoots = uniquePaths([
    path.join(rootDir, ".skills"),
    path.join(rootDir, "skills"),
    path.join(cwd, ".skills"),
    path.join(cwd, "skills"),
  ]);

  const skills = new Map<string, LoadedSkill>();
  const standaloneSkillFiles = uniquePaths([
    path.join(rootDir, "SKILL.md"),
    path.join(cwd, "SKILL.md"),
  ]);

  for (const skillFile of standaloneSkillFiles) {
    if (!(await isRegularFile(skillFile)) || isPathIgnored(skillFile, ignoreRules)) {
      continue;
    }

    const parsed = await readSkillMetadata(skillFile, rootDir);
    skills.set(parsed.name, parsed);
  }

  for (const skillRoot of candidateRoots) {
    if (!(await isDirectory(skillRoot))) {
      continue;
    }

    const skillFiles = await fg("**/SKILL.md", {
      cwd: skillRoot,
      absolute: true,
      dot: true,
      onlyFiles: true,
      suppressErrors: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    });

    for (const skillFile of skillFiles.sort((left, right) => left.localeCompare(right))) {
      if (isPathIgnored(skillFile, ignoreRules)) {
        continue;
      }

      const parsed = await readSkillMetadata(skillFile, rootDir);
      skills.set(parsed.name, parsed);
    }
  }

  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadSkillBody(skill: LoadedSkill): Promise<string> {
  const text = await fs.readFile(skill.absolutePath, "utf8");
  return parseSkillDocument(text).body;
}

async function readSkillMetadata(filePath: string, rootDir: string): Promise<LoadedSkill> {
  const text = await fs.readFile(filePath, "utf8");
  const parsed = parseSkillDocument(text);
  const triggers = parsed.triggers.length > 0 ? parsed.triggers : undefined;
  const required = parsed.required ? true : undefined;

  return {
    name: parsed.name || path.basename(path.dirname(filePath)),
    description: parsed.description || inferDescription(parsed.body),
    path: path.relative(rootDir, filePath) || "SKILL.md",
    absolutePath: filePath,
    required,
    triggers,
  };
}

function parseSkillDocument(text: string): {
  name: string;
  description: string;
  body: string;
  required: boolean;
  triggers: string[];
} {
  const normalized = text.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const frontmatter = match?.[1];
  const rawBody = match?.[2];
  const metadata = frontmatter ? parseSimpleFrontmatter(frontmatter) : {};
  const body = rawBody ? rawBody.trim() : normalized.trim();
  const required = parseBoolean(metadata.required);
  const triggers = parseTriggers(metadata.triggers || metadata.trigger);

  return {
    name: typeof metadata.name === "string" ? metadata.name.trim() : "",
    description: typeof metadata.description === "string" ? metadata.description.trim() : "",
    body,
    required,
    triggers,
  };
}

function parseSimpleFrontmatter(frontmatter: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    result[key] = value.replace(/^['"]|['"]$/g, "");
  }

  return result;
}

function parseBoolean(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function parseTriggers(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(/[,|\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferDescription(body: string): string {
  const firstContentLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));

  return firstContentLine?.slice(0, 120) ?? "";
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => path.normalize(item)))];
}
