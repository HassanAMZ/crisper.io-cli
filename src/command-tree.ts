import { type Command, type Option } from "commander";

import { ERROR_CODES, EXIT } from "./errors.js";
import { COMMAND_TOOLS } from "./tool-map.js";
import { VERSION } from "./version.js";

export const ACCOUNT_CHANGES = [
  "settings update",
  "alerts update",
  "key-events update",
  "key-events set-default",
  "key-events apply",
  "logs resend",
  "orgs create",
  "members invite",
  "members revoke",
  "members role",
  "sites add",
  "billing cancel",
  "integrations connect",
  "integrations update",
] as const;

export const EXAMPLES: Record<string, string[]> = {
  "settings get": ["crisper settings get --site example.com --json"],
  "settings update": [
    "crisper settings update --site example.com --input-stdin --yes",
  ],
  "alerts get": ["crisper alerts get --site example.com --json"],
  "alerts update": [
    "crisper alerts update --site example.com --input-stdin --yes",
  ],
  "key-events get": ["crisper key-events get --site example.com --json"],
  "key-events update": [
    "crisper key-events update --site example.com --events Purchase,SubmitApplication",
  ],
  "key-events default": ["crisper key-events default --json"],
  "key-events set-default": [
    "crisper key-events set-default --events Purchase,SubmitApplication",
  ],
  "key-events apply": [
    "crisper key-events apply --events Purchase,SubmitApplication --sites a.com,b.com --new-sites",
  ],
  "logs resend-options": [
    "crisper logs resend-options --log <id> --at 2026-11-05T00:00:00Z --json",
  ],
  "logs resend": ["crisper logs resend --log <id> --integration <id> --json"],
  login: ["crisper login", "crisper login --no-browser"],
  logout: ["crisper logout"],
  "auth status": ["crisper auth status --json"],
  "orgs list": ["crisper orgs list --json"],
  "orgs use": ["crisper orgs use", "crisper orgs use org_0123456789 --json"],
  "orgs create": ['crisper orgs create "Acme Agency" --json'],
  "members list": ["crisper members list --json"],
  "members invite": [
    "crisper members invite a@example.com b@example.com --json",
    "crisper members invite lead@example.com --admin",
  ],
  "members revoke": ["crisper members revoke a@example.com --json"],
  "members role": ["crisper members role a@example.com admin --json"],
  "sites list": ["crisper sites list --json"],
  "sites use": ["crisper sites use", "crisper sites use example.com --json"],
  "sites status": ["crisper sites status --site example.com --json"],
  "sites health": ["crisper sites health --site example.com --json"],
  "sites add": ["crisper sites add example.com --type shopify --json"],
  "billing status": ["crisper billing status --site example.com --json"],
  "billing link": ["crisper billing link --site example.com --json"],
  "billing cancel": ["crisper billing cancel --site example.com --json"],
  "dns records": ["crisper dns records --site example.com --json"],
  "install check": ["crisper install check --site example.com --json"],
  "dns check": ["crisper dns check --site example.com --json"],
  "install snippet": ["crisper install snippet --site example.com --json"],
  "install guide": ["crisper install guide --site example.com --json"],
  "events list": ["crisper events list --type purchase --limit 10 --json"],
  "events verify": ["crisper events verify --type purchase --wait 5 --json"],
  "logs list": [
    "crisper logs list --site example.com --since 24h --event Purchase --json",
  ],
  "logs export": [
    "crisper logs export --site example.com --since 7d --format csv --output logs.csv --json",
  ],
  "logs stats": [
    "crisper logs stats --site example.com --since 7d --by day,source --json",
  ],
  "logs drop": ["crisper logs drop --site example.com --json"],
  "integrations list": ["crisper integrations list --site example.com --json"],
  "integrations link": ["crisper integrations link --site example.com --json"],
  "integrations update": [
    "crisper integrations update --site example.com --integration <id> --configuration-stdin --yes",
  ],
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
    version: VERSION,
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
      // The Crisper MCP tools this command covers; the first is the one it calls.
      mcpTools: COMMAND_TOOLS[command] ?? [],
    })),
    globalOptions: program.options.map((option) => optionInfo(option, program)),
    exitCodes: EXIT_CODES,
    errorCodes: ERROR_CODES,
  };
}
