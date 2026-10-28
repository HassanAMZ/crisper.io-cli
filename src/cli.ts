import { Command, CommanderError } from "commander";

import { login, logout, status } from "./commands/auth.js";
import {
  type CommandContext,
  defaultContext,
  sessionOf,
} from "./commands/context.js";
import { orgsList, orgsUse } from "./commands/orgs.js";
import { CliError, EXIT, sanitize } from "./errors.js";
import {
  type Context,
  type Envelope,
  type OutputMode,
  type Writer,
  emit,
  envelope,
  stdio,
} from "./output.js";
import { VERSION } from "./version.js";

export type Outcome = {
  data: unknown;
  human: (env: Envelope) => string;
  meta?: Record<string, unknown>;
};

export type ProgramDeps = {
  /** Builds the per-invocation context; tests inject fakes here. */
  context?: (mode: OutputMode, signal: AbortSignal) => CommandContext;
  writer?: Writer;
  signal?: AbortSignal;
  /** The argv being parsed, so usage errors know whether `--json` was asked for. */
  argv?: string[];
  env?: NodeJS.ProcessEnv;
};

/**
 * One program, one contract: every command, including a usage error, ends
 * with exactly one envelope under `--json` and an exit code from the table in
 * the spec. Commander's own `process.exit` is overridden so that holds.
 */
export function createProgram(deps: ProgramDeps = {}): {
  program: Command;
  run: (argv: string[]) => Promise<number>;
} {
  const writer = deps.writer ?? stdio;
  const signal = deps.signal ?? new AbortController().signal;
  const env = deps.env ?? process.env;
  const makeContext = deps.context ?? defaultContext;

  const program = new Command("crisper")
    .description(
      "Crisper from the terminal. Sign in once, then set up and check conversion tracking for your sites.\nDocs: https://crisper.io/mcp",
    )
    .version(VERSION)
    .option(
      "--json",
      "write one JSON envelope to stdout; progress goes to stderr",
      false,
    )
    .option("--no-color", "plain output (also honours NO_COLOR)")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => writer.out(s.replace(/\n$/, "")),
      writeErr: (s) => writer.err(s.replace(/\n$/, "")),
    });

  let exitCode: number = EXIT.ok;

  const modeOf = (argv: string[]): OutputMode => {
    const opts = program.opts<{ json?: boolean; color?: boolean }>();
    return {
      json: Boolean(opts.json) || argv.includes("--json"),
      color:
        opts.color !== false && !env.NO_COLOR && !argv.includes("--no-color"),
    };
  };

  /** Run a command: one envelope on success or failure, exit code from the error. */
  const run = async (
    name: string,
    argv: string[],
    work: (ctx: CommandContext) => Promise<Outcome>,
  ) => {
    const mode = modeOf(argv);
    let context: Context = { origin: "" };
    let out: Writer = writer;
    try {
      const ctx = makeContext(mode, signal);
      out = ctx.writer;
      context = { origin: ctx.config.origin };
      const outcome = await work(ctx);
      emit(
        mode,
        envelope(name, context, {
          ok: true,
          data: outcome.data,
          ...(outcome.meta ? { meta: outcome.meta } : {}),
        }),
        outcome.human,
        out,
      );
      exitCode = EXIT.ok;
    } catch (error) {
      const err = sanitize(error);
      emit(
        mode,
        envelope(name, context, { ok: false, error: err }),
        () => "",
        out,
      );
      exitCode = err.exit;
    }
  };

  let argvForRun: string[] = [];

  program
    .command("login")
    .description("sign in to Crisper in your browser")
    .option("--no-browser", "print the link and code only (SSH, containers)")
    .action((opts: { browser: boolean }) =>
      run("login", argvForRun, (ctx) => login(ctx, opts)),
    );

  program
    .command("logout")
    .description("revoke this sign-in and forget it")
    .action(() => run("logout", argvForRun, logout));

  const auth = program.command("auth").description("sign-in state");
  auth
    .command("status")
    .description("who is signed in on this computer")
    .action(() => run("auth status", argvForRun, status));

  const orgs = program
    .command("orgs")
    .description("organizations this login can use");
  orgs
    .command("list")
    .description("list organizations")
    .action(() =>
      run("orgs list", argvForRun, async (ctx) =>
        orgsList(ctx, await sessionOf(ctx)),
      ),
    );
  orgs
    .command("use <orgId>")
    .description("choose the organization later commands use")
    .action((orgId: string) =>
      run("orgs use", argvForRun, async (ctx) =>
        orgsUse(ctx, await sessionOf(ctx), orgId),
      ),
    );

  const runArgv = async (argv: string[]): Promise<number> => {
    argvForRun = argv;
    exitCode = EXIT.ok;
    try {
      await program.parseAsync(argv, { from: "user" });
      return exitCode;
    } catch (error) {
      if (error instanceof CommanderError) {
        // `--help` and `--version` exit 0; help shown because a subcommand
        // is missing (`crisper orgs`) carries a nonzero code and is a usage error.
        if (error.exitCode === 0) return EXIT.ok;
        const usage = new CliError("INVALID_ARGUMENT", "Invalid arguments.", {
          exit: EXIT.usage,
          next: "Run `crisper --help`.",
        });
        const mode = modeOf(argv);
        if (mode.json)
          writer.out(
            JSON.stringify(
              envelope("crisper", { origin: "" }, { ok: false, error: usage }),
            ),
          );
        return EXIT.usage;
      }
      const err = sanitize(error);
      emit(
        modeOf(argv),
        envelope("crisper", { origin: "" }, { ok: false, error: err }),
        () => "",
        writer,
      );
      return err.exit;
    }
  };

  return { program, run: runArgv };
}
