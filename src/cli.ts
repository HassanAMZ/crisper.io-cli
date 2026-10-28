import { Command, CommanderError } from "commander";

import { login, logout, status } from "./commands/auth.js";
import {
  type CommandContext,
  defaultContext,
  sessionOf,
} from "./commands/context.js";
import { orgsList, orgsUse } from "./commands/orgs.js";
import {
  billingCancel,
  billingLink,
  billingStatus,
  dnsCheck,
  dnsRecords,
  eventsList,
  eventsVerify,
  installSnippet,
  integrationsConnect,
  integrationsList,
} from "./commands/setup.js";
import {
  SITE_TYPES,
  sitesAdd,
  sitesHealth,
  sitesList,
  sitesStatus,
  sitesUse,
} from "./commands/sites.js";
import { CliError, EXIT, sanitize } from "./errors.js";
import { runnerAware } from "./invocation.js";
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
  /** The org and site the command resolved, for the envelope's context. */
  context?: { orgId?: string | null; siteId?: string | null };
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
  const writer = deps.writer ?? runnerAware(stdio);
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
    let out: Writer = writer;
    let ctx: CommandContext | null = null;
    // Origin plus whatever org and site the command resolved before it ended.
    const contextOf = (): Context => ({
      origin: ctx?.config.origin ?? "",
      ...(ctx?.resolved.orgId ? { orgId: ctx.resolved.orgId } : {}),
      ...(ctx?.resolved.siteId ? { siteId: ctx.resolved.siteId } : {}),
    });
    try {
      ctx = makeContext(mode, signal);
      out = ctx.writer;
      const outcome = await work(ctx);
      emit(
        mode,
        envelope(
          name,
          { ...contextOf(), ...outcome.context },
          {
            ok: true,
            data: outcome.data,
            ...(outcome.meta ? { meta: outcome.meta } : {}),
          },
        ),
        outcome.human,
        out,
      );
      exitCode = EXIT.ok;
    } catch (error) {
      const err = sanitize(error);
      emit(
        mode,
        envelope(name, contextOf(), { ok: false, error: err }),
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

  // Every site command takes the same two selectors.
  type Target = { org?: string; site?: string };
  const withSite = (cmd: Command) =>
    cmd
      .option("--org <orgId>", "organization (default: `crisper orgs use`)")
      .option(
        "--site <site>",
        "website ID or domain (default: `crisper sites use`)",
      );
  const signedIn =
    <F>(
      fn: (
        ctx: CommandContext,
        session: Awaited<ReturnType<typeof sessionOf>>,
        flags: F,
      ) => Promise<Outcome>,
    ) =>
    (ctx: CommandContext, flags: F) =>
      sessionOf(ctx).then((session) => fn(ctx, session, flags));

  const sites = program
    .command("sites")
    .description("websites in an organization");
  sites
    .command("list")
    .description("list websites")
    .option("--org <orgId>", "organization (default: `crisper orgs use`)")
    .action((flags: Target) =>
      run("sites list", argvForRun, (ctx) => signedIn(sitesList)(ctx, flags)),
    );
  withSite(
    sites
      .command("use <site>")
      .description("choose the website later commands use"),
  ).action((site: string, flags: Target) =>
    run("sites use", argvForRun, (ctx) =>
      signedIn(sitesUse)(ctx, { ...flags, site }),
    ),
  );
  withSite(
    sites.command("status").description("setup progress and the next step"),
  ).action((flags: Target) =>
    run("sites status", argvForRun, (ctx) => signedIn(sitesStatus)(ctx, flags)),
  );
  withSite(
    sites
      .command("health")
      .description("purchases and leads received today and this week"),
  ).action((flags: Target) =>
    run("sites health", argvForRun, (ctx) => signedIn(sitesHealth)(ctx, flags)),
  );
  sites
    .command("add <domain>")
    .description("add a website (no charge)")
    .option("--org <orgId>", "organization (default: `crisper orgs use`)")
    .requiredOption(
      "--type <platform>",
      `website platform: ${SITE_TYPES.join(", ")}`,
    )
    .option("--timezone <zone>", "IANA timezone (default: this computer's)")
    .option("--currency <code>", "three-letter currency (default: USD)")
    .option("--no-restricted", "Meta does not restrict this business category")
    .option("--yes", "don't ask for confirmation", false)
    .action(
      (
        domain: string,
        flags: Target & {
          type: string;
          timezone?: string;
          currency?: string;
          restricted: boolean;
          yes: boolean;
        },
      ) =>
        run("sites add", argvForRun, (ctx) =>
          sessionOf(ctx).then((session) =>
            sitesAdd(ctx, session, domain, flags),
          ),
        ),
    );

  const billing = program
    .command("billing")
    .description("a website's subscription");
  withSite(billing.command("status").description("subscription state")).action(
    (flags: Target) =>
      run("billing status", argvForRun, (ctx) =>
        signedIn(billingStatus)(ctx, flags),
      ),
  );
  withSite(
    billing
      .command("link")
      .description(
        "the page to choose a plan and pay (charges nothing by itself)",
      )
      .option("--open", "open it in the browser", false),
  ).action((flags: Target & { open: boolean }) =>
    run("billing link", argvForRun, (ctx) => signedIn(billingLink)(ctx, flags)),
  );
  withSite(
    billing
      .command("cancel")
      .description("cancel at the end of the current period")
      .option("--yes", "don't ask for confirmation", false),
  ).action((flags: Target & { yes: boolean }) =>
    run("billing cancel", argvForRun, (ctx) =>
      signedIn(billingCancel)(ctx, flags),
    ),
  );

  const dns = program
    .command("dns")
    .description("the tracking domain's DNS records");
  withSite(
    dns.command("records").description("records to add at your DNS provider"),
  ).action((flags: Target) =>
    run("dns records", argvForRun, (ctx) => signedIn(dnsRecords)(ctx, flags)),
  );
  withSite(
    dns
      .command("check")
      .description("verify the records now (exit 6 until verified)"),
  ).action((flags: Target) =>
    run("dns check", argvForRun, (ctx) => signedIn(dnsCheck)(ctx, flags)),
  );

  const install = program.command("install").description("the tracking script");
  withSite(
    install.command("snippet").description("the script to add to the website"),
  ).action((flags: Target) =>
    run("install snippet", argvForRun, (ctx) =>
      signedIn(installSnippet)(ctx, flags),
    ),
  );

  const events = program.command("events").description("what Crisper received");
  withSite(
    events
      .command("list")
      .description("recent saved events, newest first")
      .option("--type <type>", "purchase or lead")
      .option("--limit <n>", "1 to 50 (default 20)"),
  ).action((flags: Target & { type?: string; limit?: string }) =>
    run("events list", argvForRun, (ctx) => signedIn(eventsList)(ctx, flags)),
  );
  withSite(
    events
      .command("verify")
      .description("did a test purchase or lead arrive? (exit 6 if not)")
      .requiredOption("--type <type>", "purchase or lead")
      .option("--since <minutes>", "look back this far (default 30)")
      .option("--wait <minutes>", "keep checking every minute, up to 10"),
  ).action((flags: Target & { type?: string; since?: string; wait?: string }) =>
    run("events verify", argvForRun, (ctx) =>
      signedIn(eventsVerify)(ctx, flags),
    ),
  );

  const integrations = program
    .command("integrations")
    .description("Meta, TikTok and other platforms");
  withSite(
    integrations.command("list").description("connected integrations"),
  ).action((flags: Target) =>
    run("integrations list", argvForRun, (ctx) =>
      signedIn(integrationsList)(ctx, flags),
    ),
  );
  withSite(
    integrations
      .command("connect")
      .description(
        "connect a Meta or TikTok pixel (the token is asked for, never a flag)",
      )
      .requiredOption("--platform <platform>", "meta or tiktok")
      .requiredOption(
        "--pixel <id>",
        "Meta pixel (dataset) ID or TikTok pixel code",
      )
      .option("--label <name>", "name shown in Crisper")
      .option(
        "--token-stdin",
        "read the access token from standard input",
        false,
      )
      .option("--yes", "don't ask for confirmation", false),
  ).action(
    (
      flags: Target & {
        platform: string;
        pixel: string;
        label?: string;
        tokenStdin: boolean;
        yes: boolean;
      },
    ) =>
      run("integrations connect", argvForRun, (ctx) =>
        signedIn(integrationsConnect)(ctx, flags),
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
