import { type Session, loadSession } from "../auth/session.js";
import { ConfigStore, KeyringStore, type SecretStore } from "../auth/store.js";
import { type CliConfig, resolveConfig } from "../config.js";
import { type OutputMode, type Writer, stdio } from "../output.js";

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
};

export function defaultContext(
  mode: OutputMode,
  signal: AbortSignal,
): CommandContext {
  return {
    config: resolveConfig(),
    mode,
    writer: stdio,
    secrets: new KeyringStore(),
    configs: new ConfigStore(),
    fetcher: fetch,
    interactive: Boolean(process.stdout.isTTY && process.stdin.isTTY),
    openBrowser: async (url) => {
      const { default: open } = await import("open");
      await open(url, { wait: false });
    },
    signal,
    now: Date.now,
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
