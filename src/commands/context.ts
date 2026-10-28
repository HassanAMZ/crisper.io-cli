import { abortableSleep } from "../auth/device.js";
import { type Session, loadSession } from "../auth/session.js";
import { ConfigStore, KeyringStore, type SecretStore } from "../auth/store.js";
import { type CliConfig, resolveConfig } from "../config.js";
import { runnerAware } from "../invocation.js";
import { quiet, retryingFetch, setProgress, spinner } from "../net.js";
import { type OutputMode, type Writer, stdio } from "../output.js";
import { type Prompter, terminal } from "../prompt.js";

/** Everything a command needs, built once per invocation and replaceable in tests. */
export type CommandContext = {
  config: CliConfig;
  mode: OutputMode;
  writer: Writer;
  secrets: SecretStore;
  configs: ConfigStore;
  fetcher: typeof fetch;
  interactive: boolean;
  openBrowser: (url: string) => Promise<void>;
  signal: AbortSignal;
  now: () => number;
  prompter: Prompter;
  /** Waits between polls (events verify); replaceable so tests don't sleep. */
  sleep: (ms: number) => Promise<void>;
  /** The org and site this command resolved, reported in success and failure envelopes. */
  resolved: { orgId?: string; siteId?: string };
};

export function defaultContext(
  mode: OutputMode,
  signal: AbortSignal,
): CommandContext {
  setProgress(!mode.json && process.stderr.isTTY ? spinner() : quiet);
  return {
    config: resolveConfig(),
    mode,
    writer: runnerAware(stdio),
    secrets: new KeyringStore(),
    configs: new ConfigStore(),
    fetcher: retryingFetch(fetch),
    interactive: Boolean(process.stdout.isTTY && process.stdin.isTTY),
    openBrowser: async (url) => {
      const { default: open } = await import("open");
      await open(url, { wait: false });
    },
    signal,
    now: Date.now,
    prompter: terminal,
    sleep: (ms) => abortableSleep(ms, signal),
    resolved: {},
  };
}

export const sessionOf = (ctx: CommandContext): Promise<Session> =>
  loadSession({
    config: ctx.config,
    secrets: ctx.secrets,
    configs: ctx.configs,
    fetcher: ctx.fetcher,
    now: ctx.now,
  });
