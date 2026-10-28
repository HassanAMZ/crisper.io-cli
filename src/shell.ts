import { createInterface } from "node:readline";

import { ConfigStore } from "./auth/store.js";
import { createProgram } from "./cli.js";
import { resolveConfig } from "./config.js";
import { safeText } from "./output.js";
import { VERSION } from "./version.js";

/**
 * `crisper` with nothing after it, at a terminal: a session where each line
 * is one command, typed without the `crisper` in front. Every line runs
 * exactly as it would from the shell, with its own Ctrl-C.
 */

/** Split a typed line into words, honouring '…' and "…" quotes. */
export function words(line: string): string[] {
  const out: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= "";
    } else if (/\s/.test(ch)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? "") + ch;
  }
  if (word !== null) out.push(word);
  return out;
}

/** Habit carries over from the shell: `crisper …` and `npx crisperio …` work too. */
export function commandOf(line: string): string[] {
  const argv = words(line);
  if (argv[0] === "npx") argv.shift();
  if (argv[0] === "crisper" || argv[0] === "crisperio") argv.shift();
  return argv;
}

/**
 * Where later commands point, for the prompt: "Sol Livio › solivio.com".
 * Empty when the names aren't known yet (they're saved as they're seen).
 */
export async function where(configs = new ConfigStore()): Promise<string> {
  const profile = (await configs.read()).profiles[resolveConfig().origin];
  if (!profile) return "not signed in";
  if (!profile.defaultOrgId) return "no organization chosen";
  return [profile.defaultOrgName, profile.defaultSiteDomain]
    .filter((p): p is string => Boolean(p))
    .map((p) => safeText(p))
    .join(" › ");
}

const dim = (text: string) =>
  process.stderr.isTTY && !process.env.NO_COLOR
    ? `\u001b[2m${text}\u001b[22m`
    : text;

function ask(question: string, history: string[]) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    history,
    historySize: 100,
    removeHistoryDuplicates: true,
  });
  return new Promise<string | null>((resolve) => {
    let answered = false;
    rl.once("SIGINT", () => {
      answered = true;
      rl.close();
      resolve("\u0003");
    });
    rl.once("close", () => {
      if (!answered) resolve(null); // Ctrl-D
    });
    rl.question(question, (answer) => {
      answered = true;
      // readline keeps the newest entry first; carry it to the next prompt.
      const latest = (rl as unknown as { history?: string[] }).history;
      if (latest) history.splice(0, history.length, ...latest);
      rl.close();
      resolve(answer);
    });
  });
}

export async function shell(): Promise<number> {
  const err = (text: string) => process.stderr.write(`${text}\n`);
  err(
    `Crisper ${VERSION} · interactive. Type commands without "crisper" in front.`,
  );
  err(
    dim(
      "Try: sites list · sites status · orgs use · sites use · help · exit (or Ctrl-D)",
    ),
  );
  if ((await where()) === "not signed in")
    err("You're not signed in yet. Type: login");
  const history: string[] = [];
  let lastWasCtrlC = false;
  for (;;) {
    err("");
    const at = await where();
    const line = await ask(`crisper${at ? ` (${at})` : ""} › `, history);
    if (line === null) break;
    if (line === "\u0003") {
      if (lastWasCtrlC) break;
      lastWasCtrlC = true;
      err(dim("(Press Ctrl-C again or type exit to leave.)"));
      continue;
    }
    lastWasCtrlC = false;
    const argv = commandOf(line);
    if (argv.length === 0) continue;
    if (["exit", "quit", "q"].includes(argv[0]!)) break;
    if (argv[0] === "help" && argv.length === 1) argv.splice(0, 1, "--help");

    // Ctrl-C while a command runs stops that command, not the session.
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.on("SIGINT", stop);
    const started = Date.now();
    try {
      const code = await createProgram({ signal: abort.signal }).run(argv);
      err(
        dim(`${Date.now() - started} ms${code === 0 ? "" : ` · exit ${code}`}`),
      );
    } finally {
      process.off("SIGINT", stop);
    }
  }
  return 0;
}
