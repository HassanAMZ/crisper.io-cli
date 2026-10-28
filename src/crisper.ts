#!/usr/bin/env node
import { createProgram } from "./cli.js";
import { EXIT } from "./errors.js";
import { shell } from "./shell.js";

const argv = process.argv.slice(2);
if (argv.length === 0 && process.stdin.isTTY && process.stderr.isTTY)
  // Just `crisper` at a terminal: stay open and take one command per line.
  process.exitCode = await shell();
else await once(argv);

async function once(argv: string[]) {
  const abort = new AbortController();
  process.once("SIGINT", () => {
    abort.abort();
    process.exitCode = EXIT.interrupted;
  });

  const { run } = createProgram({ signal: abort.signal });
  const code = await run(argv);
  if (process.exitCode === undefined || process.exitCode === EXIT.ok)
    process.exitCode = code;
}
