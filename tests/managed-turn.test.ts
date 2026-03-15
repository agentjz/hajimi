import assert from "node:assert/strict";
import test from "node:test";

import { runManagedAgentTurn } from "../src/agent/managedTurn.js";
import { MemorySessionStore } from "../src/agent/sessionStore.js";
import type { RuntimeConfig } from "../src/types.js";

function createConfig(): RuntimeConfig {
  return {
    provider: "deepseek",
    apiKey: "test-key",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-reasoner",
    mode: "agent",
    allowedRoots: ["."],
    yieldAfterToolSteps: 5,
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
      port: 4387,
      token: "",
      bind: "lan",
      publicUrl: "",
    },
    mcp: {
      enabled: false,
      servers: [],
    },
    paths: {
      configDir: ".",
      dataDir: ".",
      cacheDir: ".",
      configFile: "config.json",
      sessionsDir: "sessions",
      changesDir: "changes",
    },
  };
}

test("runManagedAgentTurn auto-continues yielded lead turns", async () => {
  const sessionStore = new MemorySessionStore();
  const initialSession = await sessionStore.create(process.cwd());
  const seenInputs: string[] = [];
  const seenYieldSteps: Array<number | undefined> = [];
  let sliceCount = 0;

  const result = await runManagedAgentTurn({
    input: "start task",
    cwd: process.cwd(),
    config: createConfig(),
    session: initialSession,
    sessionStore,
    runSlice: async (options) => {
      sliceCount += 1;
      seenInputs.push(options.input);
      seenYieldSteps.push(options.yieldAfterToolSteps);

      return {
        session: {
          ...options.session,
          title: `slice-${sliceCount}`,
        },
        changedPaths: [],
        verificationAttempted: false,
        yielded: sliceCount === 1,
      };
    },
  });

  assert.equal(sliceCount, 2);
  assert.deepEqual(seenYieldSteps, [5, 5]);
  assert.equal(seenInputs[0], "start task");
  assert.match(String(seenInputs[1]), /Resume the current task/i);
  assert.equal(result.yielded, false);
  assert.equal(result.session.title, "slice-2");
});

test("runManagedAgentTurn lets supervisors override continuation input", async () => {
  const sessionStore = new MemorySessionStore();
  const initialSession = await sessionStore.create(process.cwd());
  const seenInputs: string[] = [];
  let sliceCount = 0;

  await runManagedAgentTurn({
    input: "bootstrap",
    cwd: process.cwd(),
    config: createConfig(),
    session: initialSession,
    sessionStore,
    identity: {
      kind: "teammate",
      name: "alpha",
      role: "writer",
      teamName: "default",
    },
    onYield: async () => ({
      input: "[internal] New inbox updates are pending. Read and handle them, then continue the task.",
    }),
    runSlice: async (options) => {
      sliceCount += 1;
      seenInputs.push(options.input);
      return {
        session: options.session,
        changedPaths: [],
        verificationAttempted: false,
        yielded: sliceCount === 1,
      };
    },
  });

  assert.equal(sliceCount, 2);
  assert.equal(seenInputs[0], "bootstrap");
  assert.match(String(seenInputs[1]), /New inbox updates are pending/i);
});
