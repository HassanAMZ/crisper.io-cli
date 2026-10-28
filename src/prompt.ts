import { createInterface } from "node:readline";

import { CliError, EXIT } from "./errors.js";

/**
 * Reading from the person at the terminal. Secrets are read with echo off and
 * never from a command-line flag, so they stay out of shell history and `ps`.
 */
export type Prompter = {
  /** Ask a question and return the trimmed answer. */
  ask(question: string): Promise<string>;
  /** Ask without echoing what is typed. */
  secret(question: string): Promise<string>;
  /** Read all of standard input (for `--token-stdin`). */
  stdin(): Promise<string>;
};

export const terminal: Prompter = {
  ask(question) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      // Ctrl-C or Ctrl-D closes readline without answering: that's a cancel.
      rl.once("close", () => {
        if (settled) return;
        settled = true;
        reject(
          new CliError("INTERRUPTED", "Cancelled.", { exit: EXIT.interrupted }),
        );
      });
      rl.once("SIGINT", () => rl.close());
      rl.question(question, (answer) => {
        settled = true;
        rl.close();
        resolve(answer.trim());
      });
    });
  },
  secret(question) {
    return new Promise((resolve, reject) => {
      const input = process.stdin;
      if (!input.isTTY) {
        reject(
          new CliError(
            "INVALID_ARGUMENT",
            "No terminal to type the token into.",
            {
              exit: EXIT.usage,
              next: "Pipe it instead: `… | crisper integrations connect … --token-stdin`.",
            },
          ),
        );
        return;
      }
      process.stderr.write(question);
      input.setRawMode(true);
      input.resume();
      input.setEncoding("utf8");
      let value = "";
      const done = (result: string | null) => {
        input.setRawMode(false);
        input.pause();
        input.removeListener("data", onData);
        process.stderr.write("\n");
        if (result === null)
          reject(
            new CliError("INTERRUPTED", "Cancelled.", {
              exit: EXIT.interrupted,
            }),
          );
        else resolve(result.trim());
      };
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") return done(value);
          // Ctrl-C or Ctrl-D cancels.
          if (ch === "\u0003" || ch === "\u0004") return done(null);
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
          else if (ch >= " ") value += ch;
        }
      };
      input.on("data", onData);
    });
  },
  async stdin() {
    if (process.stdin.isTTY)
      throw new CliError(
        "INVALID_ARGUMENT",
        "--token-stdin needs the token piped in.",
        {
          exit: EXIT.usage,
          next: "Pipe it, or drop --token-stdin to type it at a hidden prompt.",
        },
      );
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  },
};

/**
 * A change needs a typed yes, or `--yes` when no one is at the keyboard.
 * Without either, nothing is changed and the command exits 2.
 */
export async function confirm(
  prompter: Prompter,
  interactive: boolean,
  yes: boolean,
  question: string,
): Promise<void> {
  if (yes) return;
  if (!interactive)
    throw new CliError(
      "INVALID_ARGUMENT",
      "This changes your account and needs a yes.",
      { exit: EXIT.usage, next: "Run it in a terminal, or add --yes." },
    );
  const answer = await prompter.ask(`${question} Type yes to continue: `);
  if (answer.toLowerCase() !== "yes")
    throw new CliError("INVALID_ARGUMENT", "Nothing was changed.", {
      exit: EXIT.usage,
    });
}
