import { type Command } from "commander";

import { ConfigStore } from "./auth/store.js";
import { createProgram } from "./cli.js";
import { resolveConfig } from "./config.js";
import { safeText } from "./output.js";
import { type Suggestion, readLine } from "./lineEditor.js";
import { type Choice, pick } from "./picker.js";
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

/** What to do with a typed line: run it, offer a menu, or ask for the rest. */
export type Plan =
  | { kind: "run"; argv: string[] }
  | { kind: "menu"; path: string[]; question: string; choices: Choice[] }
  | { kind: "needs"; prefill: string; usage: string }
  | { kind: "unknown"; word: string };

const subcommands = (cmd: Command) =>
  cmd.commands.filter((c) => c.name() !== "help");

/**
 * Nothing typed: the list of commands. A group (`dns`): its commands. A
 * command missing what it needs (`sites add`): its usage, and the line
 * typed so far to finish. Anything else runs as typed.
 */
export function plan(program: Command, argv: string[]): Plan {
  let cmd = program;
  const path: string[] = [];
  let i = 0;
  for (; i < argv.length && !argv[i]!.startsWith("-"); i++) {
    const next = subcommands(cmd).find((c) => c.name() === argv[i]);
    if (!next) {
      if (cmd === program) return { kind: "unknown", word: argv[i]! };
      break; // The rest are this command's arguments.
    }
    cmd = next;
    path.push(argv[i]!);
  }
  const rest = argv.slice(i);
  if (cmd === program && rest.length > 0) return { kind: "run", argv };
  const children = subcommands(cmd);
  if (children.length > 0) {
    const width = Math.max(...children.map((c) => c.name().length));
    return {
      kind: "menu",
      path,
      question: path.length
        ? `What would you like to do with ${path.join(" ")}?`
        : "What would you like to do?",
      choices: children.map((c) => ({
        label: `${c.name().padEnd(width)}  ${c.description()}`,
        value: c.name(),
      })),
    };
  }
  const given = rest.filter((w) => !w.startsWith("-")).length;
  const missingArg =
    cmd.registeredArguments.filter((a) => a.required).length > given;
  const missingOption = cmd.options.some(
    (o) =>
      o.mandatory &&
      !rest.some((w) => w === o.long || w.startsWith(`${o.long}=`)),
  );
  if (missingArg || missingOption)
    return {
      kind: "needs",
      prefill: `${argv.join(" ")} `,
      usage: `${path.join(" ")} ${cmd.usage()}${cmd.options
        .filter((o) => o.mandatory)
        .map((o) => ` ${o.flags}`)
        .join("")}`,
    };
  return { kind: "run", argv };
}

const dim = (text: string) =>
  process.stderr.isTTY && !process.env.NO_COLOR
    ? `\u001b[2m${text}\u001b[22m`
    : text;

/** Every command a person can run, for the suggestions under the prompt. */
export function suggestionsFor(program: Command): Suggestion[] {
  const out: Suggestion[] = [];
  const walk = (cmd: Command, path: string[]) => {
    for (const c of subcommands(cmd)) {
      const here = [...path, c.name()];
      if (subcommands(c).length > 0) walk(c, here);
      else
        out.push({
          command: here.join(" "),
          usage: [
            ...c.registeredArguments.map((a) =>
              a.required ? `<${a.name()}>` : `[${a.name()}]`,
            ),
            ...c.options.filter((o) => o.mandatory).map((o) => o.flags),
          ].join(" "),
          description: c.description(),
        });
    }
  };
  walk(program, []);
  out.push(
    { command: "help", usage: "", description: "every command and option" },
    { command: "exit", usage: "", description: "leave Crisper" },
  );
  return out;
}

export async function shell(): Promise<number> {
  const err = (text: string) => process.stderr.write(`${text}\n`);
  err(
    `Crisper ${VERSION} · interactive. Type commands without "crisper" in front.`,
  );
  err(
    dim(
      "Start typing to see matching commands, or press Enter for a menu · exit to leave",
    ),
  );
  if ((await where()) === "not signed in")
    err("You're not signed in yet. Type: login");
  const history: string[] = [];
  const suggestions = suggestionsFor(createProgram().program);
  let lastWasCtrlC = false;
  let prefill = "";
  for (;;) {
    err("");
    const at = await where();
    const line = await readLine(
      `crisper${at ? ` (${at})` : ""} › `,
      suggestions,
      history,
      prefill,
    );
    prefill = "";
    if (line && line !== "\u0003" && line.trim() && line !== history[0])
      history.unshift(line);
    if (line === null) break;
    if (line === "\u0003") {
      if (lastWasCtrlC) break;
      lastWasCtrlC = true;
      err(dim("(Press Ctrl-C again or type exit to leave.)"));
      continue;
    }
    lastWasCtrlC = false;
    let argv = commandOf(line);
    if (["exit", "quit", "q"].includes(argv[0] ?? "")) break;
    if (argv[0] === "help" && argv.length === 1) argv.splice(0, 1, "--help");

    // Ask until there's a whole command: menus for groups, the rest typed.
    const program = createProgram().program;
    let step = argv[0] === "help" ? null : plan(program, argv);
    while (step?.kind === "menu") {
      const chosen = await pick(step.question, step.choices);
      step = chosen ? plan(program, [...step.path, chosen]) : null;
      if (!chosen) argv = [];
    }
    if (step?.kind === "unknown") {
      err(
        `There's no "${safeText(step.word)}" command. Press Enter to see them all.`,
      );
      continue;
    }
    if (step?.kind === "needs") {
      err(dim(`Finish the command: ${step.usage}`));
      prefill = step.prefill;
      continue;
    }
    if (step?.kind === "run") argv = step.argv;
    if (argv.length === 0) continue;

    // Ctrl-C while a command runs stops that command, not the session.
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.on("SIGINT", stop);
    const started = Date.now();
    try {
      const code = await createProgram({ signal: abort.signal }).run(argv);
      err(
        dim(
          `Finished in ${Date.now() - started} ms${code === 0 ? "" : ` · exit ${code}`}`,
        ),
      );
    } finally {
      process.off("SIGINT", stop);
    }
  }
  return 0;
}
