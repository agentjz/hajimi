import OpenAI from "openai";

import { buildRequestContext } from "./contextBuilder.js";
import {
  emitAssistantFinalOutput,
  emitAssistantReasoning,
  handleCompletedAssistantResponse,
  shouldInjectTodoReminder,
} from "./finalize.js";
import { AgentTurnError, getErrorMessage } from "./errors.js";
import { fetchAssistantResponse } from "./api.js";
import { ToolLoopGuard } from "./loopGuard.js";
import { createMessage, createToolMessage } from "./messages.js";
import {
  buildRecoveryRequestConfig,
  buildRecoveryStatus,
  computeRecoveryDelayMs,
  isRecoverableTurnError,
  pickRequestModel,
  sleep,
} from "./retryPolicy.js";
import { injectInboxMessagesIfNeeded, loadPromptRuntimeState, shouldYieldTurn } from "./runtimeState.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { createInternalReminder, isInternalMessage } from "./taskState.js";
import { hasIncompleteTodos } from "./todos.js";
import { executeToolCallWithRecovery } from "./toolExecutor.js";
import {
  clearVerificationPause,
  isVerificationRequired,
  markVerificationRequired,
  noteVerificationReminder,
  recordVerificationAttempt,
} from "./verificationState.js";
import type { AgentIdentity, RunTurnOptions, RunTurnResult } from "./types.js";
import { ChangeStore } from "../changes/store.js";
import { loadProjectContext } from "../context/projectContext.js";
import { createRuntimeToolRegistry } from "../tools/runtimeRegistry.js";
import { throwIfAborted } from "../utils/abort.js";
import { classifyCommand } from "../utils/commandPolicy.js";
import type { LoadedSkill, SessionRecord, StoredMessage, ToolCallRecord } from "../types.js";

export type { AgentCallbacks, RunTurnOptions } from "./types.js";

export async function runAgentTurn(
  options: RunTurnOptions,
): Promise<RunTurnResult> {
  if (!options.config.apiKey) {
    throw new Error("Missing HAJIMI_API_KEY. Open the project's .env file and add your key.");
  }

  const projectContext = await loadProjectContext(options.cwd);
  const identity = options.identity ?? {
    kind: "lead" as const,
    name: "lead",
  };
  let session = await options.sessionStore.appendMessages(options.session, [
    createMessage("user", options.input),
  ]);
  session = await options.sessionStore.save({
    ...session,
    verificationState: clearVerificationPause(session.verificationState),
  });

  const client = new OpenAI({
    apiKey: options.config.apiKey,
    baseURL: options.config.baseUrl,
  });

  const toolRegistry = options.toolRegistry ?? (await createRuntimeToolRegistry(options.config));
  const changeStore = new ChangeStore(options.config.paths.changesDir);
  const loopGuard = new ToolLoopGuard();
  const softToolLimit = Math.max(1, options.config.maxToolIterations);
  const continuationWindow = softToolLimit * Math.max(1, options.config.maxContinuationBatches);
  const hadIncompleteTodosAtStart = options.identity?.kind === "lead"
    ? (options.session.todoItems ?? []).some((item) => item.status !== "completed")
    : false;
  let compressionAnnounced = false;
  let changedPaths = new Set<string>();
  let hasSubstantiveToolActivity = false;
  let validationAttempted = (session.verificationState?.attempts ?? 0) > 0;
  let validationPassed = session.verificationState?.status === "passed";
  let requiresVerification = isVerificationRequired(session.verificationState);
  let validationReminderInjected = false;
  let consecutiveRequestFailures = 0;
  let roundsSinceTodoWrite = 0;

  try {
    for (let iteration = 0; ; iteration += 1) {
      throwIfAborted(options.abortSignal, "Turn aborted by user.");

      if (shouldYieldTurn(options.yieldAfterToolSteps, iteration)) {
        options.callbacks?.onStatus?.(`Yielding after ${iteration} tool steps so background work can poll inbox and tasks.`);
        return {
          session,
          changedPaths: [...changedPaths],
          verificationAttempted: validationAttempted,
          verificationPassed: validationPassed,
          yielded: true,
          yieldReason: `tool_steps_${iteration}`,
          paused: false,
        };
      }

      session = await injectInboxMessagesIfNeeded(session, options, identity, projectContext.stateRootDir);
      throwIfAborted(options.abortSignal, "Turn aborted by user.");
      const continuationBatch = Math.floor(iteration / softToolLimit);
      const runtimeState = await loadPromptRuntimeState(projectContext.stateRootDir, identity, options.cwd);
      let systemPrompt = buildSystemPrompt(
        options.cwd,
        options.config,
        projectContext,
        session.taskState,
        session.todoItems,
        session.verificationState,
        runtimeState,
      );

      if (continuationBatch > 0) {
        systemPrompt +=
          `\n\nContinuation mode: this request is still in progress after ${iteration} tool steps.` +
          "\nContinue from the existing tool results instead of restarting." +
          "\nReuse prior discoveries, avoid repeating finished work, and push toward completion." +
          "\nDo not stop only because the task is long; keep working until you can actually complete it.";
      }

      if (consecutiveRequestFailures > 0) {
        systemPrompt +=
          `\n\nRecovery mode: the provider has failed ${consecutiveRequestFailures} time(s) in a row.` +
          "\nContinue automatically after transient failures." +
          "\nPrefer narrower next steps, smaller batches, and incremental progress over broad rework.";
      }

      const requestModel = pickRequestModel(options.config.model, consecutiveRequestFailures);
      const requestConfig = buildRecoveryRequestConfig(options.config, requestModel, consecutiveRequestFailures);

      const requestContext = buildRequestContext(
        systemPrompt,
        session.messages,
        requestConfig,
      );

      if (requestContext.compressed && !compressionAnnounced) {
        options.callbacks?.onStatus?.(
          `Context compressed automatically at ~${requestContext.estimatedChars} chars to keep the turn running.`,
        );
        compressionAnnounced = true;
      }

      if (iteration > 0 && iteration % continuationWindow === 0) {
        options.callbacks?.onStatus?.(
          `Reached ${iteration} tool steps. Auto-continuing into another continuation window...`,
        );
      } else if (iteration > 0 && iteration % softToolLimit === 0) {
        options.callbacks?.onStatus?.(
          `Reached ${iteration} tool steps. Continuing automatically with compressed context...`,
        );
      }

      let response;

      options.callbacks?.onModelWaitStart?.();
      try {
        response = await fetchAssistantResponse(
          client,
          requestContext.messages,
          requestModel,
          toolRegistry.definitions,
          options.callbacks,
          options.abortSignal,
        );
        consecutiveRequestFailures = 0;
      } catch (error) {
        if (!isRecoverableTurnError(error)) {
          throw error;
        }

        consecutiveRequestFailures += 1;
        const delayMs = computeRecoveryDelayMs(consecutiveRequestFailures);
        options.callbacks?.onStatus?.(
          buildRecoveryStatus(
            error,
            consecutiveRequestFailures,
            delayMs,
            options.config.model,
            requestModel,
            requestConfig,
          ),
        );
        await sleep(delayMs, options.abortSignal);
        continue;
      } finally {
        options.callbacks?.onModelWaitStop?.();
      }

      emitAssistantReasoning(response, options);
      throwIfAborted(options.abortSignal, "Turn aborted by user.");

      if (response.toolCalls.length === 0) {
        const missingRequiredSkills = findMissingRequiredSkills(projectContext.skills, session);
        if (missingRequiredSkills.length > 0) {
          session = await options.sessionStore.appendMessages(session, [
            createMessage("assistant", response.content ?? "", {
              reasoningContent: response.reasoningContent,
            }),
            createMessage(
              "user",
              createInternalReminder(
                `Required skill(s) not loaded: ${missingRequiredSkills.map((skill) => skill.name).join(", ")}. ` +
                  "Use load_skill for the missing skills before continuing.",
              ),
            ),
          ]);
          options.callbacks?.onStatus?.("Required skill missing. Asking the model to load it...");
          continue;
        }

        const completed = await handleCompletedAssistantResponse({
          session,
          response,
          identity,
          changedPaths,
          hadIncompleteTodosAtStart,
          hasSubstantiveToolActivity,
          verificationState: session.verificationState,
          validationReminderInjected,
          options,
        });
        if (completed.kind === "continue") {
          session = completed.session;
          validationReminderInjected = completed.validationReminderInjected;
          continue;
        }

        emitAssistantFinalOutput(response, options);
        return completed.result;
      }

      session = await options.sessionStore.appendMessages(session, [
        createMessage("assistant", response.content, {
          reasoningContent: response.reasoningContent,
          toolCalls: response.toolCalls,
        }),
      ]);

      let usedTodoWrite = false;

      for (const toolCall of response.toolCalls) {
        throwIfAborted(options.abortSignal, "Turn aborted by user.");

        options.callbacks?.onToolCall?.(toolCall.function.name, toolCall.function.arguments);
        usedTodoWrite = usedTodoWrite || toolCall.function.name === "todo_write";
        hasSubstantiveToolActivity = hasSubstantiveToolActivity || toolCall.function.name !== "todo_write";

        const command = readCommandFromArgs(toolCall.function.arguments);
        if (command && (toolCall.function.name === "run_shell" || toolCall.function.name === "background_run")) {
          const classification = classifyCommand(command);
          if (!classification.isReadOnly && !classification.validationKind) {
            session = await options.sessionStore.save({
              ...session,
              verificationState: markVerificationRequired(session.verificationState),
            });
            requiresVerification = isVerificationRequired(session.verificationState);
            validationAttempted = (session.verificationState?.attempts ?? 0) > 0;
            validationPassed = session.verificationState?.status === "passed";
            validationReminderInjected = false;
          }
        }

        const blockedResult = loopGuard.getBlockedResult(toolCall);
        const planBlockedResult = blockedResult
          ? null
          : getPlanBlockedResult(toolCall.function.name, toolCall.function.arguments, session, identity);
        const skillBlockedResult = blockedResult || planBlockedResult
          ? null
          : getSkillBlockedResult(toolCall, session, projectContext.skills);
        const result = blockedResult ?? planBlockedResult ?? skillBlockedResult ?? (await executeToolCallWithRecovery(
          toolRegistry,
          toolCall,
          options,
          projectContext,
          changeStore,
        ));
        throwIfAborted(options.abortSignal, "Turn aborted by user.");

        const metadata = "metadata" in result ? result.metadata : undefined;
        if (metadata?.changedPaths?.length) {
          changedPaths = new Set([...changedPaths, ...metadata.changedPaths]);
          loopGuard.reset();
          session = await options.sessionStore.save({
            ...session,
            verificationState: markVerificationRequired(session.verificationState, {
              pendingPaths: metadata.changedPaths,
            }),
          });
          requiresVerification = isVerificationRequired(session.verificationState);
          validationAttempted = (session.verificationState?.attempts ?? 0) > 0;
          validationPassed = session.verificationState?.status === "passed";
          validationReminderInjected = false;
        }

        if (metadata?.verification?.attempted) {
          session = await options.sessionStore.save({
            ...session,
            verificationState: recordVerificationAttempt(session.verificationState, metadata.verification),
          });
          validationAttempted = (session.verificationState?.attempts ?? 0) > 0;
          validationPassed = session.verificationState?.status === "passed";
          requiresVerification = isVerificationRequired(session.verificationState);
        }

        if (result.ok) {
          options.callbacks?.onToolResult?.(toolCall.function.name, result.output);
        } else {
          options.callbacks?.onToolError?.(toolCall.function.name, result.output);
        }

        session = await options.sessionStore.appendMessages(session, [
          createToolMessage(toolCall.id, result.output, toolCall.function.name),
        ]);
      }

      roundsSinceTodoWrite = usedTodoWrite ? 0 : roundsSinceTodoWrite + 1;
      if (shouldInjectTodoReminder(roundsSinceTodoWrite, response.toolCalls)) {
        session = await options.sessionStore.appendMessages(session, [
          createMessage(
            "user",
            createInternalReminder(
              "This task is still in progress. Use todo_write now: keep the list short, mark exactly one item in_progress, and update completed items before continuing.",
            ),
          ),
        ]);
      }

      if (requiresVerification && !validationAttempted) {
        session = await options.sessionStore.save({
          ...session,
          verificationState: noteVerificationReminder(session.verificationState),
        });
      }
    }
  } catch (error) {
    throw new AgentTurnError(getErrorMessage(error), session, { cause: error });
  }
}

const PLAN_REQUIRED_TOOLS = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "write_docx",
  "edit_docx",
  "run_shell",
  "background_run",
]);

function getPlanBlockedResult(
  toolName: string,
  rawArgs: string,
  session: RunTurnOptions["session"],
  identity: AgentIdentity,
): { ok: false; output: string } | null {
  if (identity.kind === "subagent") {
    return null;
  }

  if (!PLAN_REQUIRED_TOOLS.has(toolName)) {
    return null;
  }

  if (toolName === "run_shell" || toolName === "background_run") {
    const command = readCommandFromArgs(rawArgs);
    if (command) {
      const classification = classifyCommand(command);
      if (classification.isReadOnly || classification.validationKind) {
        return null;
      }
    }
  }

  if (hasIncompleteTodos(session.todoItems)) {
    return null;
  }

  return {
    ok: false,
    output: JSON.stringify(
      {
        ok: false,
        error: "Plan required before executing a mutating tool.",
        code: "PLAN_REQUIRED",
        hint: "Call todo_write first with a short plan (keep one item in_progress), then retry the tool call.",
        suggestedTool: "todo_write",
      },
      null,
      2,
    ),
  };
}

function getSkillBlockedResult(
  toolCall: ToolCallRecord,
  session: SessionRecord,
  skills: LoadedSkill[],
): { ok: false; output: string } | null {
  if (toolCall.function.name === "load_skill") {
    return null;
  }

  const missing = findMissingRequiredSkills(skills, session);
  if (missing.length === 0) {
    return null;
  }

  return {
    ok: false,
    output: JSON.stringify(
      {
        ok: false,
        error: "Required skill(s) not loaded.",
        code: "SKILL_REQUIRED",
        missing: missing.map((skill) => skill.name),
        hint: `Call load_skill for: ${missing.map((skill) => skill.name).join(", ")}`,
        suggestedTool: "load_skill",
      },
      null,
      2,
    ),
  };
}

function findMissingRequiredSkills(skills: LoadedSkill[], session: SessionRecord): LoadedSkill[] {
  if (!skills || skills.length === 0) {
    return [];
  }

  const requiredSkills = skills.filter((skill) => skill.required);
  if (requiredSkills.length === 0) {
    return [];
  }

  const latestUserText = findLatestUserText(session.messages);
  const objectiveText = session.taskState?.objective ?? "";
  const targetText = `${latestUserText}\n${objectiveText}`.trim().toLowerCase();
  const loaded = getLoadedSkillNames(session.messages);

  return requiredSkills.filter((skill) => {
    if (loaded.has(skill.name)) {
      return false;
    }

    if (!skill.triggers || skill.triggers.length === 0) {
      return true;
    }

    return skill.triggers.some((trigger) => trigger.toLowerCase() && targetText.includes(trigger.toLowerCase()));
  });
}

function getLoadedSkillNames(messages: StoredMessage[]): Set<string> {
  const loaded = new Set<string>();
  const pattern = /<skill\s+name="([^"]+)"/i;

  for (const message of messages) {
    if (message?.role !== "tool" || message.name !== "load_skill" || typeof message.content !== "string") {
      continue;
    }

    const match = message.content.match(pattern);
    if (match?.[1]) {
      loaded.add(match[1]);
    }
  }

  return loaded;
}

function findLatestUserText(messages: StoredMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }

    const content = message.content ?? "";
    if (!content || isInternalMessage(content)) {
      continue;
    }

    return content;
  }

  return "";
}

function readCommandFromArgs(rawArgs: string): string | null {
  try {
    const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    return typeof parsed.command === "string" ? parsed.command : null;
  } catch {
    return null;
  }
}
