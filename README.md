# crisperio

Crisper from the terminal: sign in once, then set up and check conversion tracking for your sites from a shell or an AI coding agent. Product: [crisper.io](https://crisper.io).

**Status: preview.** Commands and their `--json` output may still change before version 1.0. The same jobs work in Claude Code, Codex and Cursor through the Crisper MCP: <https://crisper.io/mcp>.

Install it once to get the `crisper` command:

```sh
npm install -g crisperio
crisper login
crisper orgs list
crisper orgs use      # pick with the arrow keys, Enter to choose
crisper sites list
```

Type just `crisper` to stay inside Crisper: each line is one command, without `crisper` in front (`sites list`, `sites status`, `exit`).

Or run it without installing; then start every command with `npx crisperio` instead of `crisper` (the CLI's own suggestions follow whichever you used):

```sh
npx crisperio login
npx crisperio orgs list
npx crisperio --json orgs list   # one JSON object on stdout, progress on stderr
```

## For AI agents

Version 0.0.9 makes `logs export` write its temporary file under a random name it creates itself, so it never writes through a file someone else placed there.
Version 0.0.8 pulls your data: `logs list` (requests in a date range, with filters and a cursor), `logs export` (to an NDJSON or CSV file, up to `--max-pages` pages of 100; `--cursor` resumes) and `logs stats` (purchases and leads counted and summed per day, source and more).
Version 0.0.7 gave every Crisper MCP tool a command (`orgs create`,
`install guide`, `integrations link` are new), lists each command's MCP tools
in `crisper commands --json` (`mcpTools`), runs a command's calls over one MCP
session (about a second faster for site commands), reports the server's retry
time after a rate limit (and `events verify --wait` waits it out), and answers `--version --json` with an envelope.
Version 0.0.6 added command discovery, examples in every command's help, precise
JSON usage errors, local target validation, and structured approval requests.
The interactive shell and arrow-key pickers remain available for humans; add
`--timing` to show request durations on stderr.

Install the skill for Claude Code, Codex, Cursor, or another compatible agent:

```sh
npx skills add HassanAMZ/crisper.io-cli
```

Or paste this into AGENTS.md or CLAUDE.md:

```text
Use crisperio for Crisper conversion tracking. Install with npm install -g
crisperio, or run npx crisperio (never npx crisper: it is an unrelated package).
Always pass --json. Discover the interface with crisper commands --json.
Branch on the exit code and error.code, and read error.next.
Check crisper --json auth status; crisper login --json needs human browser approval.
For CONFIRMATION_REQUIRED, show data.changes and run data.confirmCommand only
after human approval. Never ask for platform tokens in chat: use the hidden
terminal prompt or --token-stdin piped by the human.
```

`crisper commands --json` lists every command, argument, option, example, exit
code, and error code. See [the skill](skills/crisper/SKILL.md) for setup order.

Without `--yes`, `orgs create`, `sites add`, `billing cancel`, and `integrations connect` return
`CONFIRMATION_REQUIRED` (exit 2) in JSON or non-interactive mode. The envelope's
`data.changes` describes the proposed change and `data.confirmCommand` preserves
the invocation with `--yes` added. Show the changes, get human approval, then run
that command. JSON mode never prompts for approval, even in a TTY. An already
scheduled cancellation succeeds without another change. Exit 8 means the outcome
is unconfirmed: check status before retrying.

## Commands

| Command                                                                                  | What it does                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `crisper login`                                                                          | Opens your browser; you approve a short code. `--no-browser` prints the link only.                                                                                                                                                                           |
| `crisper auth status`                                                                    | Who is signed in on this computer, and the saved organization and website.                                                                                                                                                                                   |
| `crisper orgs list`, `orgs use [id]`                                                     | Organizations this login can use; choose one for later commands (no ID: pick from a list).                                                                                                                                                                   |
| `crisper orgs create <name>`                                                             | Create an organization and use it for later commands (reuses yours with the same name; no charge).                                                                                                                                                           |
| `crisper sites list`, `sites use [domain]`                                               | Websites in the organization; choose one for later commands (none given: pick from a list).                                                                                                                                                                  |
| `crisper sites add <domain> --type <platform>`                                           | Add a website (no charge). Defaults: USD, this computer's timezone, restricted category on.                                                                                                                                                                  |
| `crisper sites status`                                                                   | Setup progress and the one next step.                                                                                                                                                                                                                        |
| `crisper sites health`                                                                   | Purchases and leads Crisper received today and this week.                                                                                                                                                                                                    |
| `crisper billing link`, `billing status`, `billing cancel`                               | The page to pay, the subscription state, and cancel at the end of the period.                                                                                                                                                                                |
| `crisper dns records`, `dns check`                                                       | The tracking domain's DNS records; check them (exit 6 until verified).                                                                                                                                                                                       |
| `crisper install snippet`, `install guide`, `install check`                              | The tracking script for the website's platform; the dashboard's installation page for it.                                                                                                                                                                    |
| `crisper integrations list`, `integrations connect --platform meta --pixel <id>`         | Connected platforms; connect Meta or TikTok. The token is asked for at a hidden prompt (or `--token-stdin`), never as a flag.                                                                                                                                |
| `crisper integrations link`                                                              | The dashboard page to connect any other platform, such as GA4 or Google Ads.                                                                                                                                                                                 |
| `crisper events list`, `events verify --type purchase --wait 5`                          | Recent events; check that a test purchase or lead arrived.                                                                                                                                                                                                   |
| `crisper logs list --since 24h`, `logs export --since 7d --output logs.csv --format csv` | Requests in a time window (last 10 days), filtered by `--event`, `--client`, `--status`; export writes up to `--max-pages` pages to a file and says how to resume. Masked contacts only: email first letter + *** + domain, phone last four, IP first block. |
| `crisper logs stats --since 7d --by day,source`                                          | Purchases and leads counted and summed per day, event, source, medium or client (last 12 days).                                                                                                                                                              |
| `crisper logout`                                                                         | Revokes the sign-in and forgets it.                                                                                                                                                                                                                          |

Site commands take `--org <orgId>` and `--site <domain or id>`. `orgs create`, `sites add`, `billing cancel`, and `integrations connect` ask for a typed yes in human interactive mode, or require `--yes` after approval in scripts.

Add `--json` before the command for a single machine-readable envelope: `schemaVersion`, `command`, `ok`, `context`, `data`, `error`, `meta`. Exit codes: 0 ok, 1 failure, 2 usage, 3 not signed in, 4 no access, 5 rate limited, 6 needs your action, 7 unavailable, 8 unconfirmed, 130 interrupted.

## How it keeps you safe

- You never type a sign-in password or token into the terminal. Platform tokens use a hidden prompt or piped stdin. Sign-in happens on Crisper's own page, and the login can use every organization your account belongs to; the server checks that on every command.
- Tokens are kept in your operating system's credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service). There is no plain-text fallback. On macOS, the first read from a different `node` binary (for example `npx` after a Node upgrade) can prompt for Keychain access; that's the Keychain, not a bug.
- `crisper logout` revokes the sign-in on the server, then clears it locally.
- Output escapes control characters, so a site name can't rewrite your terminal.
- If a connection to Crisper can't be opened, the CLI tries twice more before giving up. Nothing has been sent at that point, so a retry can't repeat a change.

Config (no secrets) lives in `~/.config/crisperio/config.json`, or `CRISPER_CONFIG_DIR`. On macOS and Linux the directory and file are owner-only; on Windows they inherit your user profile's permissions, so keep `CRISPER_CONFIG_DIR` inside your own profile.

## Releasing

Every Crisper MCP tool has a command; `src/tool-map.ts` says which. Before a release, run `pnpm run test:parity` signed in (`crisper login`): it reads the tool list from the live server and fails if a tool has no command or a command names a tool the server doesn't have.

`crisper install check --site example.com --json` checks fetched homepage HTML for the site's loader address (8 seconds, 512 KiB maximum). A source match exits 0; absent/unknown evidence exits 7. This does not execute JavaScript or prove runtime tracking, app/checkout settings or provider delivery. Send a test event and use `crisper events verify` for receipt evidence.

Logs expose only masked contact hints: `j***@gmail.com`, `•••• 1234`, `203.*.*.*` or `2001:*:*:*:*:*:*:*`. Missing, malformed or hashed contacts are null. JSON/NDJSON include `contact`; CSV appends `emailMasked`, `phoneMasked`, `ipMasked`. No raw-contact option exists. DNS records must be added at the customer's DNS host; per-record status is unknown when the provider supplies none.
