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

Without `--yes`, `orgs create`, `sites add`, `billing cancel`, `integrations connect`, and `integrations update` return
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
| `crisper integrations list`, `integrations connect --platform meta --pixel <id>`         | Connected platforms; the legacy shortcut connects Meta or TikTok. The token is asked for at a hidden prompt (or `--token-stdin`), never as a flag.                                                                                                           |
| `crisper integrations link`                                                              | The dashboard page for provider setup guidance and browser secret entry.                                                                                                                                                                                     |
| `crisper events list`, `events verify --type purchase --wait 5`                          | Recent events; check that a test purchase or lead arrived.                                                                                                                                                                                                   |
| `crisper logs list --since 24h`, `logs export --since 7d --output logs.csv --format csv` | Requests in a time window (last 10 days), filtered by `--event`, `--client`, `--status`; export writes up to `--max-pages` pages to a file and says how to resume. Masked contacts only: email first letter + *** + domain, phone last four, IP first block. |
| `crisper logs stats --since 7d --by day,source`                                          | Purchases and leads counted and summed per day, event, source, medium or client (last 12 days).                                                                                                                                                              |
| `crisper logout`                                                                         | Revokes the sign-in and forgets it.                                                                                                                                                                                                                          |

Site commands take `--org <orgId>` and `--site <domain or id>`. `orgs create`, `sites add`, `billing cancel`, `integrations connect`, and `integrations update` ask for a typed yes in human interactive mode, or require `--yes` after approval in scripts.

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

## Integration configuration and updates

`integrations list --scope organization` lists saved integrations, including ones not attached to the selected site (bounded to 100 rows; inspect `truncated`). Default scope `site` keeps the existing 50-attachment limit. `integrations connect --integration <id> --yes` attaches a saved connection without replacing credentials. `integrations update --integration <id>` updates its full configuration across every site sharing it.

For new configurations, use `integrations connect --platform <platform>`. Enter the full JSON in the hidden prompt or pipe it with `--configuration-stdin --yes`; there is no secret-valued flag. Obtain approval before piping secrets. Existing Meta/TikTok `--pixel` and `--token-stdin` calls remain supported. Connecting an already saved provider identifier replaces its full configuration across sharing sites, including removal of omitted event mappings. The preview identifies the target and operation, removed/changed event keys and credential replacement or preservation without exposing secrets. Discovery includes the public provider identifier to distinguish unlabeled connections. At most eight pending approval slots are retained per organization; a displaced preview must be requested again. Both commands preview on the server, then submit a one-time confirmation bound to the actor, organization, site, values and current shared state. A changed or expired preview must be repeated and approved again. Deploy the new backend before this CLI.

| Platform               | Configuration fields                                                                |
| ---------------------- | ----------------------------------------------------------------------------------- |
| meta, tiktok, snapchat | `pixelId`, `capiToken`                                                              |
| ga4                    | `measurementId`, optional `apiSecret`                                               |
| gads                   | `conversionId` (bare number or AW- number), `purchase` label, optional event labels |
| twitter                | `pixelId`, `accessToken`, `purchase` event ID, optional event IDs                   |
| microsoft_ads          | `uetTagId`, `capiToken`                                                             |
| linkedin               | `accessToken`, at least one event conversion ID                                     |
| pinterest              | `advertiserId`, `capiToken`; existing integrations only                             |

Event keys are `purchase`, `generateLead`, `addToCart`, `beginCheckout`, `addPaymentInfo`, `addShippingInfo`, `pageView`, `viewCart`, `viewItem`. Updates replace the event mapping: omitted events are removed. Omitted/blank GA4 `apiSecret` preserves the existing secret on update. LinkedIn accepts one integration per site. No credential is returned by list or write responses.

`--yes` explicitly approves the org-shared impact; scripts must obtain human approval first. Manual configuration does not sign in to the provider or grant OAuth access. Use `integrations link` for browser guidance and complete any provider consent or credential acquisition yourself. A saved configuration and scheduled sync do not establish provider acceptance or event delivery.

### Site settings, alerts and re-send

`crisper settings get --site example.com --json` reads shared site settings and
whether automatic re-send is available. `crisper alerts get --site example.com
--json` separates your organization email preferences from shared website silence
rules. Required service emails are not paused.

Updates read JSON from a hidden prompt or `--input-stdin`, then show the server's
actual impact preview. Use `--preview` to return it without applying. After explicit approval, rerun identical input with the returned `--confirmation <nonce> --yes`; `--yes` alone never approves a fresh preview. For example:

```sh
printf '%s' '{"settings":{"currency":"EUR","restricted":true}}' | crisper settings update --site example.com --input-stdin --preview --json
printf '%s' '{"alerts":{"personal":{"pauseAll":true},"rules":{"eventsHours":48}}}' | crisper alerts update --site example.com --input-stdin --preview --json
```

The preview returns `data.confirmation` and `data.confirmCommand`. Run that command only after reviewing `data.changes`, re-piping the identical JSON through stdin. Secrets are not stored in the returned command. Expired or changed state/input refuses the old nonce; request and approve a new preview rather than silently renewing it.

Settings fields: `siteType`, `timezone`, `currency`, `restricted`,
`autoResendEnabled`. A separate `storefrontPassword` may accompany `settings` in
secure stdin; never put a password in shell arguments/history. Omitted fields
stay unchanged; blank password clears it. Reads only report password presence.
Site platform/password changes also affect product feeds. The automatic switch
is available only in the current rollout; its shared Meta Purchase/Lead age,
deduplication, rate and circuit-breaker rules still apply.

Alert `personal` fields: `operational`, `daily_digest`, `health_alerts`,
`setup_help`, `pauseAll`; these apply only to the signed-in user in that org.
Alert `rules`: `eventsEnabled`, `eventsHours`, `conversionsEnabled`,
`conversionsHours`, `minimumHourlyEvents`; these are shared for the chosen site.
Hours are 1–168, minimum hourly events 0–100. No bulk changes or email sends.

For a log from `logs list`, inspect its trace without raw bodies:

```sh
crisper logs resend-options --site example.com --log <logId> --at <ISO-time> --json
crisper logs resend --site example.com --log <logId> --at <ISO-time> --integration <id> --outgoing <outgoingLogId> --json
```

Omit `--outgoing` only for an undelivered Meta/TikTok event; `--collection`
selects a logged conversion collection when needed. The first call previews the
prepared send; pass its nonce with `--confirmation <nonce> --yes` and identical selectors after approval. Confirming uses the same Logs sender and reservation. Approval
expires after ten minutes and binds actor, org, site, request, payload,
credentials and attempt state. Eight reusable approval slots per org bound
retention; a later preview may displace an earlier one.

`resend-options` includes safe attempt summaries from the newest 100 site
attempts; truncation means missing history is unknown. An acceptance is not
delivery or attribution. Unknown re-send outcomes exit 8, definitive rejection
exits 6. Inspect Logs before retrying; never blindly repeat an unknown attempt.
No arbitrary payload/destination, bulk re-send, billing, archive, DNS or GTM
operation is added by these commands.
