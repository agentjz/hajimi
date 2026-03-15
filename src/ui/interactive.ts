import chalk from "chalk";

import { AgentTurnError, getErrorMessage } from "../agent/errors.js";
import { runManagedAgentTurn } from "../agent/managedTurn.js";
import { SessionStore } from "../agent/sessionStore.js";
import type { RuntimeConfig, SessionRecord } from "../types.js";
import { ui } from "../utils/console.js";
import { writeStdout } from "../utils/stdio.js";
import { isAbortError } from "../utils/abort.js";
import { handleLocalCommand } from "./localCommands.js";
import type { LocalCommandResult } from "./localCommands.js";
import { readMultilineInput, readPersistentInput } from "./persistentInput.js";
import { createWaitingSpinner, wrapCallbacksWithSpinnerStop } from "./spinner.js";
import { createStreamRenderer } from "./streamRenderer.js";

interface InteractiveOptions {
  cwd: string;
  config: RuntimeConfig;
  session: SessionRecord;
  sessionStore: SessionStore;
}

const HAJIMI_BANNER = [
  "██╗  ██╗ █████╗      ██╗██╗███╗   ███╗██╗",
  "██║  ██║██╔══██╗     ██║██║████╗ ████║██║",
  "███████║███████║     ██║██║██╔████╔██║██║",
  "██╔══██║██╔══██║██   ██║██║██║╚██╔╝██║██║",
  "██║  ██║██║  ██║╚█████╔╝██║██║ ╚═╝ ██║██║",
  "╚═╝  ╚═╝╚═╝  ╚═╝ ╚════╝ ╚═╝╚═╝     ╚═╝╚═╝",
].join("\n");

export async function startInteractiveChat(options: InteractiveOptions): Promise<void> {
  ui.plain(renderBanner());
  ui.dim(`session: ${options.session.id}`);
  ui.dim(`cwd: ${options.cwd}`);
  printLaunchHints(options.config.mode);

  const interruptNotice = createInterruptNotice();

  let session = options.session;
  let turnInFlight = false;
  let turnAbortController: AbortController | null = null;

  const onSigint = (): void => {
    if (turnInFlight && turnAbortController && !turnAbortController.signal.aborted) {
      turnAbortController.abort();
      interruptNotice("Interrupted the current turn. You can continue typing.");
      return;
    }

    interruptNotice("This session will not exit automatically. Type quit or q to exit.");
  };

  process.on("SIGINT", onSigint);

  try {
    while (true) {
      const rawInput = await readPersistentInput("> ", onSigint);
      if (rawInput === null) {
        ui.warn("This session will not exit automatically. Type quit or q to exit.");
        continue;
      }

      const input = rawInput.trim();
      if (!input) {
        continue;
      }

      let localCommandResult: LocalCommandResult;
      try {
        localCommandResult = await handleLocalCommand(input, {
          cwd: options.cwd,
          session,
          config: options.config,
        });
      } catch (error) {
        ui.error(getErrorMessage(error));
        continue;
      }

      if (localCommandResult === "quit") {
        break;
      }

      if (localCommandResult === "multiline") {
        ui.info("已进入多行输入模式。输入 ::end 提交，输入 ::cancel 取消。\n");
        const multiline = await readMultilineInput(onSigint);
        if (multiline.kind === "cancel") {
          ui.warn("已取消多行输入。\n");
          continue;
        }

        if (multiline.kind === "eof") {
          ui.warn("多行输入被中断。\n");
          continue;
        }

        const value = multiline.value.trim();
        if (!value) {
          ui.warn("多行输入为空，未发送。\n");
          continue;
        }

        await runInteractiveTurn(value, options, session, {
          setSession: (next) => {
            session = next;
          },
          setTurnInFlight: (value) => {
            turnInFlight = value;
          },
          setTurnAbortController: (controller) => {
            turnAbortController = controller;
          },
        });
        continue;
      }

      if (localCommandResult === "handled") {
        continue;
      }

      await runInteractiveTurn(input, options, session, {
        setSession: (next) => {
          session = next;
        },
        setTurnInFlight: (value) => {
          turnInFlight = value;
        },
        setTurnAbortController: (controller) => {
          turnAbortController = controller;
        },
      });
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

function renderBanner(): string {
  return chalk.bold(chalk.greenBright(HAJIMI_BANNER));
}

async function runInteractiveTurn(
  input: string,
  options: InteractiveOptions,
  session: SessionRecord,
  state: {
    setSession: (session: SessionRecord) => void;
    setTurnInFlight: (value: boolean) => void;
    setTurnAbortController: (controller: AbortController | null) => void;
  },
): Promise<void> {
  state.setTurnInFlight(true);
  const controller = new AbortController();
  state.setTurnAbortController(controller);

  const streamRenderer = createStreamRenderer(options.config, {
    cwd: options.cwd,
    assistantLeadingBlankLine: true,
    assistantTrailingNewlines: "\n\n",
    reasoningLeadingBlankLine: true,
    toolArgsMaxChars: 200,
    toolErrorLabel: "failed, retrying via model",
    abortSignal: controller.signal,
  });
  const waitingSpinner = createWaitingSpinner({ label: "thinking" });
  const callbacks = wrapCallbacksWithSpinnerStop(streamRenderer.callbacks, () => {
    waitingSpinner.stop();
  });
  callbacks.onModelWaitStart = () => {
    waitingSpinner.start();
  };
  callbacks.onModelWaitStop = () => {
    waitingSpinner.stop();
  };

  try {
    const result = await runManagedAgentTurn({
      input,
      cwd: options.cwd,
      config: options.config,
      session,
      sessionStore: options.sessionStore,
      abortSignal: controller.signal,
      callbacks,
      identity: {
        kind: "lead",
        name: "lead",
      },
    });
    state.setSession(result.session);
    if (result.paused && result.pauseReason) {
      ui.warn(result.pauseReason);
    }
  } catch (error) {
    waitingSpinner.stop();
    streamRenderer.flush();

    if (error instanceof AgentTurnError) {
      state.setSession(error.session);
    }

    if (isAbortError(error)) {
      ui.warn("Turn interrupted. You can keep chatting.");
    } else {
      ui.error(getErrorMessage(error));
      ui.info("The request failed, but the session is still alive. You can keep chatting.");
    }
  } finally {
    waitingSpinner.stop();
    state.setTurnInFlight(false);
    state.setTurnAbortController(null);
  }
}

function printLaunchHints(mode: RuntimeConfig["mode"]): void {
  const modeLabel = mode === "agent" ? "agent" : "read-only";
  const modeSwitchHint = mode === "agent" ? "hajimi --mode read-only" : "hajimi --mode agent";
  ui.dim(`Current mode: ${modeLabel}`);
  ui.dim(`Switch mode: ${modeSwitchHint}`);
  ui.dim("Remote: hajimi remote");
  ui.dim("Commands:");
  ui.dim("/help        帮助");
  ui.dim("/multi       多行输入");
  ui.dim("/tasks       任务板");
  ui.dim("/team        队友");
  ui.dim("/background  后台任务");
  ui.dim("/worktrees   工作区");
  ui.dim("/inbox       收件箱");
  ui.dim("quit         退出");
  ui.dim("::end        提交多行输入");
  ui.dim("::cancel     取消多行输入\n");
}

function createInterruptNotice(): (message: string) => void {
  let lastShownAt = 0;

  return (message: string): void => {
    const now = Date.now();
    if (now - lastShownAt < 150) {
      return;
    }

    lastShownAt = now;
    writeStdout("\n");
    ui.warn(message);
  };
}
