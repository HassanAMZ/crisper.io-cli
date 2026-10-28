import { CliError, EXIT } from "./errors.js";

/**
 * An arrow-key list on stderr: ↑/↓ move, Enter or Space chooses, typing
 * filters, Esc skips. The state and drawing are plain functions so they can
 * be tested without a terminal; `pick` wires them to stdin in raw mode.
 */
export type Choice = { label: string; value: string };

export type PickerState = { cursor: number; filter: string };

export type Key =
  "up" | "down" | "choose" | "skip" | "cancel" | "erase" | { text: string };

/** Rows shown at once; longer lists scroll. */
export const VISIBLE_ROWS = 10;

/** Split one chunk of raw input into keys. Unknown escape sequences are dropped. */
export function keysOf(chunk: string): Key[] {
  const keys: Key[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]!;
    if (ch === "\u001b") {
      // Arrows arrive as ESC [ A or, in application mode, ESC O A.
      const next = chunk[i + 1];
      if (next === "[" || next === "O") {
        let end = i + 2;
        while (end < chunk.length && !/[A-Za-z~]/.test(chunk[end]!)) end++;
        const final = chunk[end];
        if (final === "A") keys.push("up");
        else if (final === "B") keys.push("down");
        i = end;
      } else keys.push("skip");
    } else if (ch === "\r" || ch === "\n" || ch === " ") keys.push("choose");
    else if (ch === "\u0003" || ch === "\u0004") keys.push("cancel");
    else if (ch === "\u007f" || ch === "\b") keys.push("erase");
    else if (ch >= " ") keys.push({ text: ch });
  }
  return keys;
}

export function visible(choices: Choice[], filter: string): Choice[] {
  const f = filter.toLowerCase();
  return f ? choices.filter((c) => c.label.toLowerCase().includes(f)) : choices;
}

/** Apply one key. `done` is the chosen value, or null when skipped. */
export function step(
  state: PickerState,
  key: Key,
  choices: Choice[],
): { state: PickerState; done?: string | null } {
  const shown = visible(choices, state.filter);
  if (key === "up" || key === "down") {
    if (shown.length === 0) return { state };
    const delta = key === "up" ? -1 : 1;
    const cursor = (state.cursor + delta + shown.length) % shown.length;
    return { state: { ...state, cursor } };
  }
  if (key === "choose") {
    const choice = shown[state.cursor];
    return choice ? { state, done: choice.value } : { state };
  }
  if (key === "skip" || key === "cancel") return { state, done: null };
  const filter =
    key === "erase" ? state.filter.slice(0, -1) : state.filter + key.text;
  return { state: { cursor: 0, filter } };
}

/** The lines to draw, each cut to fit `columns` so nothing wraps. */
export function frame(
  question: string,
  state: PickerState,
  choices: Choice[],
  columns = 80,
): string[] {
  const shown = visible(choices, state.filter);
  const first = Math.min(
    Math.max(0, state.cursor - VISIBLE_ROWS + 1),
    Math.max(0, shown.length - VISIBLE_ROWS),
  );
  const rows = shown.slice(first, first + VISIBLE_ROWS);
  const lines = [
    question,
    "↑/↓ move · Enter or Space choose · type to search · Esc skip",
    ...(state.filter ? [`Search: ${state.filter}`] : []),
    ...(rows.length === 0 ? ["  (nothing matches)"] : []),
    ...rows.map(
      (c, i) => `${first + i === state.cursor ? "❯" : " "} ${c.label}`,
    ),
    ...(shown.length > rows.length
      ? [`  ${first + 1}–${first + rows.length} of ${shown.length}`]
      : []),
  ];
  return lines.map((line) => [...line].slice(0, columns - 1).join(""));
}

/**
 * Ask on the terminal. Resolves with the chosen value, or null on Esc,
 * Ctrl-C or Ctrl-D. Needs stdin and stderr to be a terminal.
 */
export function pick(
  question: string,
  choices: Choice[],
): Promise<string | null> {
  const input = process.stdin;
  const output = process.stderr;
  if (!input.isTTY)
    return Promise.reject(
      new CliError("INVALID_ARGUMENT", "No terminal to choose in.", {
        exit: EXIT.usage,
      }),
    );
  return new Promise((resolve) => {
    let state: PickerState = { cursor: 0, filter: "" };
    let drawn = 0;
    const clear = () => {
      if (drawn > 1) output.write(`\u001b[${drawn - 1}A`);
      output.write("\r\u001b[J");
    };
    const draw = () => {
      clear();
      const lines = frame(question, state, choices, output.columns || 80);
      output.write(lines.join("\n"));
      drawn = lines.length;
    };
    const onData = (chunk: string) => {
      for (const key of keysOf(chunk)) {
        const next = step(state, key, choices);
        state = next.state;
        if (next.done !== undefined) return finish(next.done);
      }
      draw();
    };
    const finish = (value: string | null) => {
      clear();
      output.write("\u001b[?25h");
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      resolve(value);
    };
    output.write("\u001b[?25l");
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onData);
    draw();
  });
}
