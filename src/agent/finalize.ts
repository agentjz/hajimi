import { createMessage } from "./messages.js";
import { createInternalReminder } from "./taskState.js";
import { hasIncompleteTodos } from "./todos.js";
import { isVerificationAwaitingUser, isVerificationRequired, noteVerificationReminder } from "./verificationState.js";
import type { AgentIdentity, AssistantResponse, RunTurnOptions, RunTurnResult } from "./types.js";
import type { SessionRecord, ToolCallRecord, VerificationState } from "../types.js";

interface HandleCompletedAssistantResponseParams {
  session: SessionRecord;
  response: AssistantResponse;
  identity: AgentIdentity;
  changedPaths: Set<string>;
  hadIncompleteTodosAtStart: boolean;
  hasSubstantiveToolActivity: boolean;
  verificationState?: VerificationState;
  validationReminderInjected: boolean;
  options: RunTurnOptions;
}

export async function handleCompletedAssistantResponse(
  params: HandleCompletedAssistantResponseParams,
): Promise<
  | {
      kind: "continue";
      session: SessionRecord;
      validationReminderInjected: boolean;
    }
  | {
      kind: "return";
      result: RunTurnResult;
    }
> {
  const assistantMessage = createMessage("assistant", params.response.content ?? "", {
    reasoningContent: params.response.reasoningContent,
  });
  const requiresVerification = isVerificationRequired(params.verificationState);
  const verificationAwaitingUser = isVerificationAwaitingUser(params.verificationState);
  const validationAttempted = (params.verificationState?.attempts ?? 0) > 0;
  const validationPassed = params.verificationState?.status === "passed";

  const canFinishWithPlanningTodos =
    !params.hadIncompleteTodosAtStart &&
    !params.hasSubstantiveToolActivity &&
    params.changedPaths.size === 0;

  if (verificationAwaitingUser) {
    const session = await params.options.sessionStore.appendMessages(params.session, [assistantMessage]);
    return {
      kind: "return",
      result: {
        session,
        changedPaths: [...params.changedPaths],
        verificationAttempted: validationAttempted,
        verificationPassed: validationPassed,
        yielded: false,
        paused: true,
        pauseReason: params.verificationState?.pauseReason,
      },
    };
  }

  if (
    params.identity.kind === "lead" &&
    hasIncompleteTodos(params.session.todoItems) &&
    !canFinishWithPlanningTodos
  ) {
    const session = await params.options.sessionStore.appendMessages(params.session, [
      assistantMessage,
      createMessage(
        "user",
        createInternalReminder(
          "Your todo list still has incomplete items. Do not finalize yet. Either continue the work, or call todo_write to update the list so it accurately reflects what is done and what remains.",
        ),
      ),
    ]);
    params.options.callbacks?.onStatus?.("Todo list still has open items. Asking the model to continue...");
    return {
      kind: "continue",
      session,
      validationReminderInjected: params.validationReminderInjected,
    };
  }

  if (requiresVerification && !validationAttempted) {
    const changedSummary = params.changedPaths.size > 0
      ? ` (${[...params.changedPaths].slice(0, 6).join(", ")})`
      : "";
    const reminder = params.validationReminderInjected
      ? `Still waiting on verification${changedSummary}. Run a targeted build/test before finalizing.`
      : `Verification required${changedSummary}. Run at least one targeted verification command before finalizing (for example a build or test).`;
    const verificationState = noteVerificationReminder(params.session.verificationState);
    const baseSession = await params.options.sessionStore.save({
      ...params.session,
      verificationState,
    });
    if (isVerificationAwaitingUser(verificationState)) {
      const session = await params.options.sessionStore.appendMessages(baseSession, [assistantMessage]);
      return {
        kind: "return",
        result: {
          session,
          changedPaths: [...params.changedPaths],
          verificationAttempted: false,
          verificationPassed: false,
          yielded: false,
          paused: true,
          pauseReason: verificationState.pauseReason,
        },
      };
    }

    const session = await params.options.sessionStore.appendMessages(baseSession, [
      assistantMessage,
      createMessage("user", createInternalReminder(reminder)),
    ]);
    params.options.callbacks?.onStatus?.("Verification required before finishing. Asking the model to verify...");
    return {
      kind: "continue",
      session,
      validationReminderInjected: true,
    };
  }

  if (requiresVerification && validationAttempted && !validationPassed) {
    const session = await params.options.sessionStore.appendMessages(params.session, [
      assistantMessage,
      createMessage(
        "user",
        createInternalReminder(
          "Verification failed. Fix the issues and rerun verification before finalizing. Do not finish with known failing checks.",
        ),
      ),
    ]);
    params.options.callbacks?.onStatus?.("Verification failed. Asking the model to fix and re-verify...");
    return {
      kind: "continue",
      session,
      validationReminderInjected: true,
    };
  }

  const session = await params.options.sessionStore.appendMessages(params.session, [assistantMessage]);
  return {
    kind: "return",
    result: {
      session,
      changedPaths: [...params.changedPaths],
      verificationAttempted: validationAttempted,
      verificationPassed: validationPassed,
      yielded: false,
      paused: false,
    },
  };
}

export function shouldInjectTodoReminder(roundsSinceTodoWrite: number, toolCalls: ToolCallRecord[]): boolean {
  return toolCalls.length > 0 && roundsSinceTodoWrite >= 3 && roundsSinceTodoWrite % 3 === 0;
}

export function emitAssistantReasoning(response: AssistantResponse, options: RunTurnOptions): void {
  if (response.reasoningContent && options.config.showReasoning && !response.streamedReasoningContent) {
    options.callbacks?.onReasoning?.(response.reasoningContent);
  }
}

export function emitAssistantFinalOutput(response: AssistantResponse, options: RunTurnOptions): void {
  if (response.content && !response.streamedAssistantContent) {
    options.callbacks?.onAssistantText?.(response.content);
  }

  if (response.content) {
    options.callbacks?.onAssistantDone?.(response.content);
  }
}
