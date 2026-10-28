# crisperio

Crisper from the terminal: sign in once, then set up and check conversion tracking for your sites from a shell or an AI coding agent. Product: [crisper.io](https://crisper.io).

**Status: preview.** Commands and their `--json` output may still change before version 1.0. The same jobs work in Claude Code, Codex and Cursor through the Crisper MCP: <https://crisper.io/mcp>.

```sh
npx crisperio login
npx crisperio orgs list
npx crisperio --json orgs list   # one JSON object on stdout, progress on stderr
```

## Commands

| Command                                                                          | What it does                                                                                                                  |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `crisper login`                                                                  | Opens your browser; you approve a short code. `--no-browser` prints the link only.                                            |
| `crisper auth status`                                                            | Who is signed in on this computer, and the saved organization and website.                                                    |
| `crisper orgs list`, `orgs use <id>`                                             | Organizations this login can use; choose one for later commands.                                                              |
| `crisper sites list`, `sites use <domain>`                                       | Websites in the organization; choose one for later commands.                                                                  |
| `crisper sites add <domain> --type <platform>`                                   | Add a website (no charge). Defaults: USD, this computer's timezone, restricted category on.                                   |
| `crisper sites status`                                                           | Setup progress and the one next step.                                                                                         |
| `crisper sites health`                                                           | Purchases and leads Crisper received today and this week.                                                                     |
| `crisper billing link`, `billing status`, `billing cancel`                       | The page to pay, the subscription state, and cancel at the end of the period.                                                 |
| `crisper dns records`, `dns check`                                               | The tracking domain's DNS records; check them (exit 6 until verified).                                                        |
| `crisper install snippet`                                                        | The tracking script for the website's platform.                                                                               |
| `crisper integrations list`, `integrations connect --platform meta --pixel <id>` | Connected platforms; connect Meta or TikTok. The token is asked for at a hidden prompt (or `--token-stdin`), never as a flag. |
| `crisper events list`, `events verify --type purchase --wait 5`                  | Recent events; check that a test purchase or lead arrived.                                                                    |
| `crisper logout`                                                                 | Revokes the sign-in and forgets it.                                                                                           |

Site commands take `--org <orgId>` and `--site <domain or id>`. Anything that changes your account asks for a typed yes, or `--yes` in scripts.

Add `--json` before the command for a single machine-readable envelope: `schemaVersion`, `command`, `ok`, `context`, `data`, `error`, `meta`. Exit codes: 0 ok, 1 failure, 2 usage, 3 not signed in, 4 no access, 5 rate limited, 6 needs your action, 7 unavailable, 8 unconfirmed, 130 interrupted.

## How it keeps you safe

- You never type a password or token into the terminal. Sign-in happens on Crisper's own page, and the login can use every organization your account belongs to; the server checks that on every command.
- Tokens are kept in your operating system's credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service). There is no plain-text fallback. On macOS, the first read from a different `node` binary (for example `npx` after a Node upgrade) can prompt for Keychain access; that's the Keychain, not a bug.
- `crisper logout` revokes the sign-in on the server, then clears it locally.
- Output escapes control characters, so a site name can't rewrite your terminal.

Config (no secrets) lives in `~/.config/crisperio/config.json`, or `CRISPER_CONFIG_DIR`. On macOS and Linux the directory and file are owner-only; on Windows they inherit your user profile's permissions, so keep `CRISPER_CONFIG_DIR` inside your own profile.
