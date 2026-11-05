---
name: crisper
description: Use when setting up or checking Crisper conversion tracking, sites, DNS, billing, integrations, or events from a terminal with the crisperio CLI.
---

# Crisper from an agent

Install with `npm install -g crisperio`, or prefix commands with `npx crisperio` instead of `crisper`. WARNING: never use `npx crisper`; that npm name is an unrelated package.

Always pass `--json` when running Crisper commands. Stdout is one envelope: `schemaVersion`, `command`, `ok`, `context`, `data`, `error`, `meta`. Branch on the process exit code AND `error.code`; read `error.next` before acting. Discover commands, required options, examples, and errors with `crisper commands --json`. Use each command's `--help` for human-readable help.

## Sign in and choose a target

Check `crisper --json auth status`. If sign-in is needed, `crisper login --json` starts a browser device flow that a human approves. Wait for their approval. Use `crisper orgs list --json` and `crisper sites list --json` to find targets. Pass `--org` and `--site` explicitly for work on a particular organization/site; organization IDs start with `org_` followed by 10–64 letters or digits. Do not guess an organization or site when several are available.

## Setup order

Use the returned next step and repeat status after completing each step:

1. `crisper sites status --site example.com --json`
2. `crisper billing link --site example.com --json` — the human chooses and pays
   for a plan on the returned page; fetching the link makes no charge.
3. `crisper dns records --site example.com --json`, then
   `crisper dns check --site example.com --json` after adding the records.
4. `crisper install snippet --site example.com --json` — follow the platform's
   installation instructions; generating a script does not prove installation.
   `crisper install check --site example.com --json` checks fetched homepage source
   only (exit 7 if absent/unknown); a match does not prove runtime or provider tracking.
5. `crisper integrations connect --site example.com --platform meta --pixel 1234567890 --json`
6. Send a test purchase, then
   `crisper events verify --site example.com --type purchase --wait 5 --json`.
   This proves Crisper received the event, not platform acceptance.

For reports, `crisper logs stats --site example.com --since 7d --by day,source --json` counts purchases and leads; `crisper logs list --since 24h --json` pages requests (pass `data.nextCursor` back with `--cursor`), and `crisper logs export --since 7d --output logs.ndjson --json` writes them to a file, up to `--max-pages` pages of 100. For export, `data.complete` false means it stopped early: resume with `--cursor` set to `data.nextCursor` and a new `--output`. `data.partial` true means Stape skipped rows in a busy stretch. For stats, `data.coverage.complete` false means counts are a minimum. Logs expose masked contacts only: email first letter + *** + domain, phone last four digits, IP first block. Missing/malformed or hashed contacts are null; there is no raw-contact option.

If the site does not exist, propose it with `crisper sites add example.com --type shopify --json` first; with no organization yet, `crisper orgs create "Business name" --json` comes before it. `crisper integrations link --json` returns browser setup guidance. All dashboard manual providers support `integrations connect --platform <platform>` with hidden configuration JSON or `--configuration-stdin`; consult `integrations --help` for the fields. Pinterest is existing-only. `integrations list --scope organization` discovers saved IDs; `connect --integration <id>` attaches one without changing credentials. `integrations update --integration <id>` replaces the full configuration for every site sharing it (omitted event mappings are removed; omitted GA4 apiSecret is preserved). Replace the example domain and pixel ID with the human's actual target.

## Changes need human approval

`orgs create`, `sites add`, `billing cancel`, `integrations connect`, and `integrations update` return `CONFIRMATION_REQUIRED` (exit 2) without making the change when `--yes` is absent. The envelope's `data.changes` explains the effects; `data.confirmCommand` is the original invocation with `--yes` added. Show the changes to the human. Only run `confirmCommand` after the human approves those changes. JSON mode never asks for a typed yes, even with a TTY. An already scheduled cancellation can succeed without another change.

Never ask the human to paste platform tokens into chat. For integration tokens, have the human pipe legacy Meta/TikTok tokens using `--token-stdin`, full provider JSON using `--configuration-stdin`, or use the hidden terminal prompt. The server previews each write and requires a one-time confirmation; explain the org-shared impact before approval. Request approval before token entry. Tokens are never command arguments. Run `confirmCommand` exactly as given; it already starts with `npx crisperio` when the CLI was started that way. Exit 8 means a change may have happened: inspect status before retrying.

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

## Settings, alerts and re-send

Use `settings get` and `alerts get` with explicit org/site before proposing a change. `settings update --input-stdin` accepts `{ "settings": { ... } }` and an optional `storefrontPassword`; use secure stdin for that secret, never a flag or chat echo. `alerts update --input-stdin` accepts `{ "alerts": { "personal": { ... }, "rules": { ... } } }`. Use `--help` for field names. Omitted fields are not written; alert defaults a login inherits can still change, so read the full preview. Personal preferences apply only to this login in this org; silence rules and site settings are shared. Use `--preview` to read the actual impact and `data.confirmation`. After approval, rerun identical selectors/input with `--confirmation <nonce> --yes` (or the returned `data.confirmCommand`, re-piping identical JSON). `--yes` alone cannot approve a fresh preview; stale or changed input needs a new preview and approval. Automatic re-send remains subject to rollout and shared safety rules. No command sends notification email immediately.

Use `logs resend-options --log <incomingId> --at <ISO-time>` to inspect safe trace and saved attempt evidence. `logs resend --log <incomingId> --integration <id> --outgoing <outgoingId>` retries a failed outgoing request; omit `--outgoing` only for the shared Meta/TikTok undelivered path. Confirm the actual impact before passing its nonce with `--confirmation <nonce> --yes`; never invent a payload or destination. Unknown attempts are not retry permission. Acceptance is not delivery or attribution. Use explicit customer authorization; this skill grants none. Bulk/archive/billing/GTM/DNS changes remain outside these commands.
