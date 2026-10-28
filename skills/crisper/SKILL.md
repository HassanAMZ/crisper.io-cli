---
name: crisper
description: Use when setting up or checking Crisper conversion tracking, sites, DNS, billing, integrations, or events from a terminal with the crisperio CLI.
---

# Crisper from an agent

Install with `npm install -g crisperio`, or prefix commands with `npx crisperio`
instead of `crisper`. WARNING: never use `npx crisper`; that npm name is an
unrelated package.

Always pass `--json` when running Crisper commands. Stdout is one envelope:
`schemaVersion`, `command`, `ok`, `context`, `data`, `error`, `meta`.
Branch on the process exit code AND `error.code`; read `error.next` before acting.
Discover commands, required options, examples, and errors with
`crisper commands --json`. Use each command's `--help` for human-readable help.

## Sign in and choose a target

Check `crisper --json auth status`. If sign-in is needed, `crisper login --json`
starts a browser device flow that a human approves. Wait for their approval.
Use `crisper orgs list --json` and `crisper sites list --json` to find targets.
Pass `--org` and `--site` explicitly for work on a particular organization/site;
organization IDs start with `org_` followed by 10–64 letters or digits.
Do not guess an organization or site when several are available.

## Setup order

Use the returned next step and repeat status after completing each step:

1. `crisper sites status --site example.com --json`
2. `crisper billing link --site example.com --json` — the human chooses and pays
   for a plan on the returned page; fetching the link makes no charge.
3. `crisper dns records --site example.com --json`, then
   `crisper dns check --site example.com --json` after adding the records.
4. `crisper install snippet --site example.com --json` — follow the platform's
   installation instructions; generating a script does not prove installation.
5. `crisper integrations connect --site example.com --platform meta --pixel 1234567890 --json`
6. Send a test purchase, then
   `crisper events verify --site example.com --type purchase --wait 5 --json`.
   This proves Crisper received the event, not platform acceptance.

If the site does not exist, propose it with
`crisper sites add example.com --type shopify --json` first.
Replace the example domain and pixel ID with the human's actual target.

## Changes need human approval

`sites add`, `billing cancel`, and `integrations connect` return
`CONFIRMATION_REQUIRED` (exit 2) without making the change when `--yes` is absent.
The envelope's `data.changes` explains the effects; `data.confirmCommand` is the
original invocation with `--yes` added. Show the changes to the human. Only run
`confirmCommand` after the human approves those changes. JSON mode never asks
for a typed yes, even with a TTY. An already scheduled cancellation can succeed
without another change.

Never ask the human to paste platform tokens into chat. For integration tokens,
have the human pipe the token using `--token-stdin`, or use the hidden terminal
prompt. Request approval before token entry. Tokens are never command arguments.
Run `confirmCommand` exactly as given; it already starts with `npx crisperio`
when the CLI was started that way.
Exit 8 means a change may have happened: inspect status before retrying.

## Exit codes

| Code | Meaning                                       |
| ---- | --------------------------------------------- |
| 0    | OK                                            |
| 1    | Failure                                       |
| 2    | Usage or confirmation required                |
| 3    | Authentication required or expired            |
| 4    | Access denied or conflict                     |
| 5    | Rate limited                                  |
| 6    | Customer action needed or event not observed  |
| 7    | Capability unavailable or incomplete evidence |
| 8    | Change or revocation unconfirmed              |
| 130  | Interrupted                                   |
