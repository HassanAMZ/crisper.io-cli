# crisperio

Crisper from the terminal: sign in once, then set up and check conversion tracking for your sites from a shell or an AI coding agent. Product: [crisper.io](https://crisper.io).

**Status: preview.** Sign-in for this CLI isn't switched on for crisper.io yet. Until it is, `crisper login` says so and points you to the Crisper MCP, which works today in Claude Code, Codex and Cursor: <https://crisper.io/mcp>.

```sh
npx crisperio login
npx crisperio orgs list
npx crisperio --json orgs list   # one JSON object on stdout, progress on stderr
```

## Commands

| Command                 | What it does                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `crisper login`         | Opens your browser; you approve a short code. `--no-browser` prints the link only. |
| `crisper auth status`   | Who is signed in on this computer.                                                 |
| `crisper orgs list`     | Organizations this login can use.                                                  |
| `crisper orgs use <id>` | Choose the organization later commands use.                                        |
| `crisper logout`        | Revokes the sign-in and forgets it.                                                |

Add `--json` before the command for a single machine-readable envelope: `schemaVersion`, `command`, `ok`, `context`, `data`, `error`, `meta`. Exit codes: 0 ok, 1 failure, 2 usage, 3 not signed in, 4 no access, 5 rate limited, 6 needs your action, 7 unavailable, 8 unconfirmed, 130 interrupted.

## How it keeps you safe

- You never type a password or token into the terminal. Sign-in happens on Crisper's own page, and the login can use every organization your account belongs to; the server checks that on every command.
- Tokens are kept in your operating system's credential store (macOS Keychain, Windows Credential Manager, Linux Secret Service). There is no plain-text fallback. On macOS, the first read from a different `node` binary (for example `npx` after a Node upgrade) can prompt for Keychain access; that's the Keychain, not a bug.
- `crisper logout` revokes the sign-in on the server, then clears it locally.
- Output escapes control characters, so a site name can't rewrite your terminal.

Config (no secrets) lives in `~/.config/crisperio/config.json`, or `CRISPER_CONFIG_DIR`. On macOS and Linux the directory and file are owner-only; on Windows they inherit your user profile's permissions, so keep `CRISPER_CONFIG_DIR` inside your own profile.
