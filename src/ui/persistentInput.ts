import readline from "node:readline";

export async function readPersistentInput(
  promptLabel: string,
  onInterrupt: () => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    let settled = false;

    const cleanup = (): void => {
      rl.removeAllListeners("line");
      rl.removeAllListeners("close");
      rl.removeAllListeners("SIGINT");
    };

    const finish = (value: string | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      rl.close();
      resolve(value);
    };

    rl.on("line", (line) => {
      finish(line);
    });

    rl.on("SIGINT", () => {
      onInterrupt();
      rl.prompt();
    });

    rl.on("close", () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(null);
    });

    rl.setPrompt(promptLabel);
    rl.prompt();
  });
}

export type MultilineInputResult =
  | { kind: "submit"; value: string }
  | { kind: "cancel" }
  | { kind: "eof" };

export async function readMultilineInput(onInterrupt: () => void): Promise<MultilineInputResult> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const lines: string[] = [];
    let settled = false;

    const cleanup = (): void => {
      rl.removeAllListeners("line");
      rl.removeAllListeners("close");
      rl.removeAllListeners("SIGINT");
    };

    const finish = (value: MultilineInputResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      rl.close();
      resolve(value);
    };

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed === "::end") {
        finish({ kind: "submit", value: lines.join("\n") });
        return;
      }

      if (trimmed === "::cancel") {
        finish({ kind: "cancel" });
        return;
      }

      lines.push(line);
      rl.prompt();
    });

    rl.on("SIGINT", () => {
      onInterrupt();
      rl.prompt();
    });

    rl.on("close", () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve({ kind: "eof" });
    });

    rl.setPrompt("… ");
    rl.prompt();
  });
}
