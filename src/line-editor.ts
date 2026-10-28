/**
 * The interactive prompt's input line. As you type, the commands that match
 * appear underneath: ↑/↓ pick one, Tab fills it in, Enter runs it. With no
 * suggestion showing, ↑/↓ walk back through earlier lines. The state and the
 * drawing are plain functions; `readLine` wires them to a raw-mode terminal.
 */
export type Suggestion = {
  /** What gets typed: "sites list". */
  command: string;
  /** Shown after it: "<domain> --type <platform>". */
  usage: string;
  description: string;
};

export type EditorState = {
  text: string;
  selected: number;
  /** Esc hides suggestions until the next keystroke. */
  hidden: boolean;
  /** Position in history while walking it; -1 when editing a new line. */
  historyAt: number;
};

export type EditorKey =
  | "up"
  | "down"
  | "tab"
  | "enter"
  | "escape"
  | "erase"
  | "eraseWord"
  | "clear"
  | "interrupt"
  | "eof"
  | { text: string };

/** Suggestions shown at once. */
export const MAX_SUGGESTIONS = 6;

export function editorKeys(chunk: string): EditorKey[] {
  const keys: EditorKey[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]!;
    if (ch === "\u001b") {
      const next = chunk[i + 1];
      if (next === "[" || next === "O") {
        let end = i + 2;
        while (end < chunk.length && !/[A-Za-z~]/.test(chunk[end]!)) end++;
        if (chunk[end] === "A") keys.push("up");
        else if (chunk[end] === "B") keys.push("down");
        i = end;
      } else keys.push("escape");
    } else if (ch === "\r" || ch === "\n") keys.push("enter");
    else if (ch === "\t") keys.push("tab");
    else if (ch === "\u007f" || ch === "\b") keys.push("erase");
    else if (ch === "\u0017") keys.push("eraseWord");
    else if (ch === "\u0015") keys.push("clear");
    else if (ch === "\u0003") keys.push("interrupt");
    else if (ch === "\u0004") keys.push("eof");
    else if (ch >= " ") {
      const last = keys.at(-1);
      // Typed or pasted text arrives together; keep it as one key.
      if (last && typeof last === "object") last.text += ch;
      else keys.push({ text: ch });
    }
  }
  return keys;
}

/**
 * Commands matching what's typed: those starting with it first, then those
 * containing it, then those whose description mentions it. Nothing once the
 * line goes past a command into its arguments.
 */
export function suggest(text: string, all: Suggestion[]): Suggestion[] {
  const typed = text.trimStart().toLowerCase().replace(/\s+/g, " ");
  if (!typed) return [];
  if (all.some((s) => typed.startsWith(`${s.command} `))) return [];
  const starts = all.filter((s) => s.command.startsWith(typed));
  const contains = all.filter(
    (s) =>
      !starts.includes(s) &&
      typed.trim().length >= 2 &&
      s.command.includes(typed.trim()),
  );
  const described = all.filter(
    (s) =>
      !starts.includes(s) &&
      !contains.includes(s) &&
      typed.trim().length >= 3 &&
      s.description.toLowerCase().includes(typed.trim()),
  );
  const found = [...starts, ...contains, ...described];
  // A finished command needs no list under it.
  if (found.length === 1 && found[0]!.command === typed.trim()) return [];
  return found;
}

export type EditorResult = { state: EditorState; submit?: string | null };

export function edit(
  state: EditorState,
  key: EditorKey,
  all: Suggestion[],
  history: string[],
): EditorResult {
  const shown = state.hidden ? [] : suggest(state.text, all);
  const typing = (text: string): EditorResult => ({
    state: { text, selected: 0, hidden: false, historyAt: -1 },
  });
  if (typeof key === "object") return typing(state.text + key.text);
  switch (key) {
    case "erase":
      return typing(state.text.slice(0, -1));
    case "eraseWord":
      return typing(state.text.replace(/\S+\s*$/, ""));
    case "clear":
      return typing("");
    case "escape":
      return { state: { ...state, hidden: true } };
    case "interrupt":
      // On a half-typed line Ctrl-C clears it; on an empty one it's a leave.
      return state.text ? typing("") : { state, submit: "\u0003" };
    case "eof":
      return state.text ? { state } : { state, submit: null };
    case "tab": {
      const pick = shown[state.selected];
      return pick ? typing(`${pick.command} `) : { state };
    }
    case "enter": {
      const pick = shown[state.selected];
      return { state, submit: pick ? pick.command : state.text };
    }
    case "up":
    case "down": {
      if (shown.length > 0) {
        const delta = key === "up" ? -1 : 1;
        const selected = (state.selected + delta + shown.length) % shown.length;
        return { state: { ...state, selected } };
      }
      // No list showing: walk the history, newest first.
      const at =
        key === "up"
          ? Math.min(state.historyAt + 1, history.length - 1)
          : state.historyAt - 1;
      if (at < 0)
        return {
          state: { text: "", selected: 0, hidden: true, historyAt: -1 },
        };
      return {
        state: {
          text: history[at] ?? "",
          selected: 0,
          hidden: true,
          historyAt: at,
        },
      };
    }
  }
}

/** The lines under the input: the matching commands, the chosen one marked. */
export function suggestionLines(
  state: EditorState,
  all: Suggestion[],
  columns = 80,
): string[] {
  if (state.hidden) return [];
  if (!state.text.trim())
    return ["  Type to see matching commands · Enter for a menu of everything"];
  const shown = suggest(state.text, all);
  if (shown.length === 0) return [];
  const first = Math.min(
    Math.max(0, state.selected - MAX_SUGGESTIONS + 1),
    Math.max(0, shown.length - MAX_SUGGESTIONS),
  );
  const rows = shown.slice(first, first + MAX_SUGGESTIONS);
  const width = Math.max(
    ...rows.map((s) => `${s.command} ${s.usage}`.trim().length),
  );
  const lines = rows.map((s, i) => {
    const name = `${s.command} ${s.usage}`.trim().padEnd(width);
    return `${first + i === state.selected ? "❯" : " "} ${name}  ${s.description}`;
  });
  if (shown.length > rows.length)
    lines.push(`  ${shown.length - rows.length} more · keep typing to narrow`);
  lines.push("  ↑/↓ choose · Tab fill in · Enter run · Esc hide");
  return lines.map((line) => [...line].slice(0, columns - 1).join(""));
}

const dim = (text: string) => `\u001b[2m${text}\u001b[22m`;

/**
 * Read one line with live suggestions. Resolves with the line, "\u0003" for
 * Ctrl-C on an empty line, or null for Ctrl-D.
 */
export function readLine(
  prompt: string,
  all: Suggestion[],
  history: string[],
  prefill = "",
): Promise<string | null> {
  const input = process.stdin;
  const output = process.stderr;
  const color = !process.env.NO_COLOR;
  return new Promise((resolve) => {
    let state: EditorState = {
      text: prefill,
      selected: 0,
      hidden: false,
      historyAt: -1,
    };
    const draw = () => {
      const columns = output.columns || 80;
      const lines = suggestionLines(state, all, columns);
      // Back to the input line, clear it and everything under it.
      output.write(`\r\u001b[J${prompt}${state.text}`);
      if (lines.length) {
        output.write(`\n${lines.map((l) => (color ? dim(l) : l)).join("\n")}`);
        output.write(`\u001b[${lines.length}A\r`);
        const at = [...prompt].length + [...state.text].length;
        if (at > 0) output.write(`\u001b[${at % columns}C`);
      }
    };
    const finish = (value: string | null) => {
      // Leave the typed line on screen, drop the suggestions under it.
      output.write(
        `\r\u001b[J${prompt}${value && value !== "\u0003" ? value : state.text}\n`,
      );
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const key of editorKeys(chunk)) {
        const next = edit(state, key, all, history);
        state = next.state;
        if (next.submit !== undefined) return finish(next.submit);
      }
      draw();
    };
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onData);
    draw();
  });
}
