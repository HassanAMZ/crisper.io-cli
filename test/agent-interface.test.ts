import { readFileSync } from "node:fs";
import { type Command } from "commander";
import { describe, expect, it } from "vitest";

import { defaultContext } from "../src/commands/context.js";
import { createProgram } from "../src/cli.js";
import {
  ACCOUNT_CHANGES,
  commandCatalog,
  leafCommands,
} from "../src/command-tree.js";
import { ERROR_CODES, EXIT } from "../src/errors.js";
import { suggestionsFor, words } from "../src/shell.js";

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const writer = {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
  };
  const { program, run } = createProgram({
    writer,
    context: (mode, signal) => ({ ...defaultContext(mode, signal), writer }),
    env: {},
  });
  return { program, run, out, err };
}

// Independent walk checks that the shared catalog and suggestions omit nothing.
function leaves(node: Command, path: string[] = []): string[] {
  return node.commands
    .filter((c) => c.name() !== "help")
    .flatMap((c) =>
      c.commands.length
        ? leaves(c, [...path, c.name()])
        : [[...path, c.name()].join(" ")],
    );
}

describe("agent command discovery and help", () => {
  it("lists every parser leaf, its metadata, global options, and stable codes without signing in", async () => {
    const h = harness();
    expect(await h.run(["commands", "--json"])).toBe(0);
    expect(h.out).toHaveLength(1);
    const env = JSON.parse(h.out[0]!);
    expect(Object.keys(env)).toEqual([
      "schemaVersion",
      "command",
      "ok",
      "context",
      "data",
      "error",
      "meta",
    ]);
    expect(env.command).toBe("commands");
    const catalog = commandCatalog(h.program);
    expect(env.data).toEqual(catalog);
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.commands.map((c) => c.command)).toEqual(leaves(h.program));
    expect(
      catalog.commands
        .filter((c) => c.changesAccount)
        .map((c) => c.command)
        .sort(),
    ).toEqual([...ACCOUNT_CHANGES].sort());
    expect([...ACCOUNT_CHANGES].sort()).toEqual([
      "billing cancel",
      "integrations connect",
      "sites add",
    ]);
    expect(catalog.errorCodes).toEqual(ERROR_CODES);
    expect(catalog.errorCodes).toContain("CONFIRMATION_REQUIRED");
    expect(
      Object.keys(catalog.exitCodes)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual(Object.values(EXIT).sort((a, b) => a - b));
    expect(
      catalog.globalOptions.find((o) => o.flags === "--json"),
    ).toMatchObject({ required: false, default: false });
    expect(
      catalog.commands.find((c) => c.command === "sites add"),
    ).toMatchObject({
      arguments: [{ name: "domain", required: true }],
      options: expect.arrayContaining([
        {
          flags: "--type <platform>",
          description: expect.stringContaining("(required)"),
          required: true,
          default: null,
        },
      ]),
    });
    expect(
      suggestionsFor(h.program)
        .filter((s) => !["help", "exit"].includes(s.command))
        .map((s) => s.command),
    ).toEqual(leaves(h.program));
  });

  it("prints an aligned, readable human catalog", async () => {
    const h = harness();
    expect(await h.run(["commands"])).toBe(0);
    const lines = h.out[0]!.split("\n");
    expect(lines).toHaveLength(leaves(h.program).length);
    expect(lines.find((line) => line.startsWith("sites add"))).toMatch(
      /^sites add\s{2,}add a website/,
    );
  });

  it("ends every leaf's help with 1–2 parseable examples and marks mandatory options", async () => {
    for (const { command, node } of leafCommands(createProgram().program)) {
      const h = harness();
      expect(await h.run([...command.split(" "), "--help"])).toBe(0);
      const help = h.out.join("\n");
      expect(help).toContain("Examples:\n");
      const examples = help
        .split("Examples:\n")[1]!
        .trim()
        .split("\n")
        .map((s) => s.trim());
      expect(examples.length).toBeGreaterThanOrEqual(1);
      expect(examples.length).toBeLessThanOrEqual(2);
      expect(
        commandCatalog(h.program).commands.find((c) => c.command === command)
          ?.examples,
      ).toEqual(examples);
      for (const option of node.options.filter((o) => o.mandatory))
        expect(help.replace(/\s+/g, " ")).toContain(option.description);
      for (const example of examples) {
        const check = harness();
        const stop = new Error("example parsed; do not execute");
        let reached = false;
        check.program.hook("preAction", () => {
          reached = true;
          throw stop;
        });
        await expect(
          check.program.parseAsync(words(example).slice(1), { from: "user" }),
        ).rejects.toBe(stop);
        expect(reached).toBe(true);
      }
    }
  });

  it("explains JSON, discovery, and all exit codes in top-level help", async () => {
    const h = harness();
    expect(await h.run(["--help"])).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("Agents: add --json");
    expect(text).toContain("crisper commands --json");
    for (const [code, meaning] of Object.entries(
      commandCatalog(h.program).exitCodes,
    ))
      expect(text).toContain(`${code} ${meaning}`);
  });

  it.each([
    {
      argv: ["orgs", "lst", "--json"],
      message: "unknown command 'lst' (Did you mean list?)",
      help: "orgs",
    },
    {
      argv: ["sites", "add", "example.com", "--json"],
      message: "required option '--type <platform>' not specified",
      help: "sites add",
    },
    {
      argv: ["--json", "events", "verify"],
      message: "required option '--type <type>' not specified",
      help: "events verify",
    },
  ])(
    "preserves precise usage error for $argv",
    async ({ argv, message, help }) => {
      const h = harness();
      expect(await h.run(argv)).toBe(2);
      expect(h.out).toHaveLength(1);
      expect(JSON.parse(h.out[0]!).error).toMatchObject({
        code: "INVALID_ARGUMENT",
        message,
        next: `Run \`crisper ${help} --help\`.`,
      });
    },
  );

  it("ships the 0.0.6 agent guidance with a narrowly allowed skill", () => {
    const skill = readFileSync("skills/crisper/SKILL.md", "utf8");
    expect(skill).toMatch(/^---\nname: crisper\ndescription: Use when/);
    expect(skill.split("\n").length).toBeLessThanOrEqual(95);
    for (const required of [
      "npm install -g crisperio",
      "never use `npx crisper`",
      "crisper commands --json",
      "CONFIRMATION_REQUIRED",
      "data.changes",
      "data.confirmCommand",
      "--token-stdin",
      "error.next",
    ])
      expect(skill).toContain(required);
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("## For AI agents");
    expect(readme).toContain("npx skills add HassanAMZ/crisper.io-cli");
    expect(readme).toContain("arrow-key pickers");
    expect(readme).toContain("--timing");
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.version).toBe("0.0.6");
    expect(pkg.files).toEqual(["dist", "README.md"]);
  });
});
