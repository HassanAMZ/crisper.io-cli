#!/usr/bin/env node
import { createProgram } from "./cli.js";
import { EXIT } from "./errors.js";

const abort = new AbortController();
process.once("SIGINT", () => {
  abort.abort();
  process.exitCode = EXIT.interrupted;
});

const { run } = createProgram({ signal: abort.signal });
run(process.argv.slice(2)).then((code) => {
  if (process.exitCode === undefined || process.exitCode === EXIT.ok)
    process.exitCode = code;
});
