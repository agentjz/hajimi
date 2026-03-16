import type { McpConfig } from "./mcp/types.js";

export type AgentMode = "read-only" | "agent";

export interface AppPaths {
  configDir: string;
  dataDir: string;
  cacheDir: string;
  configFile: string;
  sessionsDir: string;
  changesDir: string;
}

export interface AppConfig {
  provider: "deepseek";
  baseUrl: string;
  model: string;
  mode: AgentMode;
  allowedRoots: string[];
  yieldAfterToolSteps: number;
  contextWindowMessages: number;
  maxContextChars: number;
  contextSummaryChars: number;
  maxToolIterations: number;
  maxContinuationBatches: number;
  maxReadBytes: number;
  maxSearchResults: number;
  maxSpreadsheetPreviewRows: number;
  maxSpreadsheetPreviewColumns: number;
  commandStallTimeoutMs: number;
  commandMaxRetries: number;
  commandRetryBackoffMs: number;
  showReasoning: boolean;
  remote: RemoteConfig;
  mcp: McpConfig;
}

export interface RuntimeConfig extends AppConfig {
  apiKey: string;
  paths: AppPaths;
}

export interface CliOverrides {
  cwd?: string;
  model?: string;
  mode?: AgentMode;
}

export interface RemoteConfig {
  enabled: boolean;
  host: string;
  port: number;
  bind: string;
  publicUrl: string;
}

export interface ToolCallRecord {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface StoredMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCallRecord[];
  reasoningContent?: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  title?: string;
  messageCount: number;
  messages: StoredMessage[];
  todoItems?: TodoItem[];
  taskState?: TaskState;
  verificationState?: VerificationState;
}

export interface VerificationAttempt {
  attempted: boolean;
  command: string;
  exitCode: number | null;
  kind?: string;
  passed?: boolean;
}

export interface ToolExecutionMetadata {
  changedPaths?: string[];
  changeId?: string;
  verification?: VerificationAttempt;
}

export interface ToolExecutionResult {
  ok: boolean;
  output: string;
  metadata?: ToolExecutionMetadata;
}

export interface LoadedSkill {
  name: string;
  description: string;
  path: string;
  absolutePath: string;
  required?: boolean;
  triggers?: string[];
}

export interface LoadedInstructionFile {
  path: string;
  relativePath: string;
  filename: "AGENTS.override.md" | "AGENTS.md";
  content: string;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

export interface ProjectIgnoreRule {
  pattern: string;
  source: string;
  baseDir: string;
  negated: boolean;
  directoryOnly: boolean;
  matcher: RegExp;
}

export interface ProjectContext {
  rootDir: string;
  stateRootDir: string;
  cwd: string;
  instructions: LoadedInstructionFile[];
  instructionText: string;
  instructionTruncated: boolean;
  skills: LoadedSkill[];
  ignoreRules: ProjectIgnoreRule[];
}

export interface TaskState {
  objective?: string;
  activeFiles: string[];
  plannedActions: string[];
  completedActions: string[];
  blockers: string[];
  lastUpdatedAt: string;
}

export type VerificationStatus = "idle" | "required" | "passed" | "awaiting_user";

export interface VerificationState {
  status: VerificationStatus;
  attempts: number;
  reminderCount: number;
  noProgressCount: number;
  maxAttempts: number;
  maxNoProgress: number;
  maxReminders: number;
  pendingPaths: string[];
  lastCommand?: string;
  lastKind?: string;
  lastExitCode?: number | null;
  lastFailureSignature?: string;
  pauseReason?: string;
  updatedAt: string;
}

export interface ChangeOperationRecord {
  path: string;
  kind: "create" | "update" | "delete";
  binary: boolean;
  beforeBytes?: number;
  afterBytes?: number;
  beforeSnapshotPath?: string;
  afterSnapshotPath?: string;
  preview?: string;
}

export interface ChangeRecord {
  id: string;
  createdAt: string;
  sessionId?: string;
  cwd: string;
  toolName: string;
  summary: string;
  preview?: string;
  operations: ChangeOperationRecord[];
  undoneAt?: string;
}
