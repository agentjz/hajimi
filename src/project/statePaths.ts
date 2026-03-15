import fs from "node:fs/promises";
import path from "node:path";

export interface ProjectStatePaths {
  rootDir: string;
  teamDir: string;
  backgroundDir: string;
  inboxDir: string;
  messageLogFile: string;
  coordinationPolicyFile: string;
  teamConfigFile: string;
  requestsDir: string;
  tasksDir: string;
  worktreesDir: string;
  worktreeIndexFile: string;
  worktreeEventsFile: string;
}

export function getProjectStatePaths(rootDir: string): ProjectStatePaths {
  const normalizedRoot = path.resolve(rootDir);
  const hajimiDir = path.join(normalizedRoot, ".hajimi");
  const teamDir = path.join(hajimiDir, "team");
  const worktreesDir = path.join(hajimiDir, "worktrees");
  return {
    rootDir: normalizedRoot,
    teamDir,
    backgroundDir: path.join(teamDir, "background"),
    inboxDir: path.join(teamDir, "inbox"),
    messageLogFile: path.join(teamDir, "messages.jsonl"),
    coordinationPolicyFile: path.join(teamDir, "policy.json"),
    teamConfigFile: path.join(teamDir, "config.json"),
    requestsDir: path.join(teamDir, "requests"),
    tasksDir: path.join(hajimiDir, "tasks"),
    worktreesDir,
    worktreeIndexFile: path.join(worktreesDir, "index.json"),
    worktreeEventsFile: path.join(worktreesDir, "events.jsonl"),
  };
}

export async function ensureProjectStateDirectories(rootDir: string): Promise<ProjectStatePaths> {
  const paths = getProjectStatePaths(rootDir);
  await fs.mkdir(paths.teamDir, { recursive: true });
  await fs.mkdir(paths.backgroundDir, { recursive: true });
  await fs.mkdir(paths.inboxDir, { recursive: true });
  await fs.mkdir(paths.requestsDir, { recursive: true });
  await fs.mkdir(paths.tasksDir, { recursive: true });
  await fs.mkdir(paths.worktreesDir, { recursive: true });
  return paths;
}
