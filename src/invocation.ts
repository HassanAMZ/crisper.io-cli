import { fileURLToPath } from "node:url";

import { type Writer } from "./output.js";

/**
 * npx, pnpm dlx and similar run the package from a temporary cache, so the
 * `crisper` command doesn't exist in the person's shell afterwards. Suggested
 * commands then have to start with `npx crisperio` to work when copied.
 */
export function viaRunner(
  file: string = fileURLToPath(import.meta.url),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.npm_command === "exec" ||
    /[\\/](_npx|dlx|bunx-[^\\/]*|yarn-dlx-[^\\/]*)[\\/]/.test(file)
  );
}

/** Rewrites `crisper <command>` in output to how this run was started. */
export function commandsFor(runner: boolean): (text: string) => string {
  if (!runner) return (text) => text;
  return (text) =>
    text.replace(/(^|[\s`"'(])crisper(?= [a-z])/g, "$1npx crisperio");
}

/** The terminal writer, with suggested commands matching how this run was started. */
export function runnerAware(writer: Writer, runner = viaRunner()): Writer {
  const rewrite = commandsFor(runner);
  return {
    out: (text) => writer.out(rewrite(text)),
    err: (text) => writer.err(rewrite(text)),
  };
}
