import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";

export async function createTempWorkspace(prefix: string, t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(process.cwd(), `.test-tmp-${prefix}-`));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

export function makeToolContext(root: string, cwd = root, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    config: {
      allowedRoots: ["*"],
    },
    cwd,
    sessionId: "test-session",
    identity: {
      kind: "lead",
      name: "lead",
    },
    projectContext: {
      stateRootDir: root,
      skills: [],
    },
    changeStore: {},
    createToolRegistry: () => ({}),
    ...overrides,
  };
}

export async function initGitRepo(root: string): Promise<void> {
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Codex Tests"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: root, stdio: "ignore" });
  await fs.writeFile(path.join(root, "README.md"), "# test repo\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
}
