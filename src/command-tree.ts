import { type Command, type Option } from "commander";

import { ERROR_CODES, EXIT } from "./errors.js";

export const ACCOUNT_CHANGES = [
  "sites add",
  "billing cancel",
  "integrations connect",
] as const;

export const EXAMPLES: Record<string, string[]> = {
  login: ["crisper login", "crisper login --no-browser"],
  logout: ["crisper logout"],
  "auth status": ["crisper auth status --json"],
  "orgs list": ["crisper orgs list --json"],
  "orgs use": ["crisper orgs use", "crisper orgs use org_0123456789 --json"],
  "sites list": ["crisper sites list --json"],
  "sites use": ["crisper sites use", "crisper sites use example.com --json"],
  "sites status": ["crisper sites status --site example.com --json"],
  "sites health": ["crisper sites health --site example.com --json"],
  "sites add": ["crisper sites add example.com --type shopify --json"],
  "billing status": ["crisper billing status --site example.com --json"],
  "billing link": ["crisper billing link --site example.com --json"],
  "billing cancel": ["crisper billing cancel --site example.com --json"],
  "dns records": ["crisper dns records --site example.com --json"],
  "dns check": ["crisper dns check --site example.com --json"],
  "install snippet": ["crisper install snippet --site example.com --json"],
  "events list": ["crisper events list --type purchase --limit 10 --json"],
  "events verify": ["crisper events verify --type purchase --wait 5 --json"],
  "integrations list": ["crisper integrations list --site example.com --json"],
  "integrations connect": [
    "crisper integrations connect --site example.com --platform meta --pixel 1234567890 --json",
  ],
  commands: ["crisper commands --json", "crisper commands"],
};

export const subcommands = (cmd: Command) =>
  cmd.commands.filter((c) => c.name() !== "help");

/** One traversal for discovery, help, and interactive suggestions. */
export function commandTree(
  program: Command,
): { command: string; node: Command }[] {
  const out: { command: string; node: Command }[] = [];
  const walk = (cmd: Command, path: string[]) => {
    for (const node of subcommands(cmd)) {
      const here = [...path, node.name()];
      out.push({ command: here.join(" "), node });
      walk(node, here);
    }
  };
  walk(program, []);
  return out;
}

export const leafCommands = (program: Command) =>
  commandTree(program).filter(({ node }) => subcommands(node).length === 0);

const optionInfo = (option: Option, node: Command) => ({
  flags: option.flags,
  description: option.description,
  required: option.mandatory,
  default:
    option.defaultValue ??
    (option.negate &&
    !node.options.some(
      (other) =>
        !other.negate && other.attributeName() === option.attributeName(),
    )
      ? true
      : null),
});

export const EXIT_CODES = Object.fromEntries(
  Object.entries(EXIT).map(([name, code]) => [String(code), name]),
);

/** Read the actual parser definitions so the catalog cannot invent flags. */
export function commandCatalog(program: Command) {
  return {
    schemaVersion: 1,
    commands: leafCommands(program).map(({ command, node }) => ({
      command,
      description: node.description(),
      arguments: node.registeredArguments.map((arg) => ({
        name: arg.name(),
        required: arg.required,
      })),
      options: node.options.map((option) => optionInfo(option, node)),
      examples: EXAMPLES[command] ?? [],
      changesAccount: (ACCOUNT_CHANGES as readonly string[]).includes(command),
    })),
    globalOptions: program.options.map((option) => optionInfo(option, program)),
    exitCodes: EXIT_CODES,
    errorCodes: ERROR_CODES,
  };
}
