import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { type Session } from "../auth/session.js";
import { CliError, EXIT } from "../errors.js";
import { waiting } from "../net.js";
import { safeText } from "../output.js";
import { VERSION } from "../version.js";

/**
 * The CLI is one more MCP client. Every command is a tool call to
 * `<origin>/api/mcp` with the customer's own token; the server decides what
 * that token may see. A 401 gets one refresh and one retry, then exit 3.
 */
export type ToolResult = { data: unknown; requestId: string | null };

/** The SDK's error carries only the status; the server's Retry-After is kept here. */
let lastRetryAfter: number | null = null;

/** Where the server puts a tool error's stable code (lib/mcp/server.ts). */
export const ERROR_CODE_META = "io.crisper/errorCode";

function paused(retryAfterSeconds = 60) {
  return new CliError(
    "CAPABILITY_UNAVAILABLE",
    "Crisper's terminal access is paused right now.",
    {
      exit: EXIT.unavailable,
      retryable: true,
      retryAfterSeconds,
      next: "Use the dashboard for now and try again later.",
    },
  );
}
function transient(retryAfterSeconds: number) {
  return new CliError("SERVER_ERROR", "Crisper couldn't answer just now.", {
    exit: EXIT.failure,
    retryable: true,
    retryAfterSeconds,
    next: `Try again in ${retryAfterSeconds} seconds.`,
  });
}
function rateLimited(retryAfterSeconds: number) {
  return new CliError("RATE_LIMITED", "Too many requests right now.", {
    exit: EXIT.rateLimited,
    retryable: true,
    retryAfterSeconds,
    next: `Wait ${retryAfterSeconds} seconds and try again.`,
  });
}
function notVisible() {
  return new CliError(
    "ACCESS_DENIED",
    "Not found, or this login can't see it.",
    {
      exit: EXIT.denied,
      next: "Check `crisper orgs list`, `crisper sites list` and the --org or --site value.",
    },
  );
}
function generic() {
  return new CliError(
    "SERVER_ERROR",
    "Crisper could not complete that request.",
    {
      exit: EXIT.failure,
      next: "Check the values you passed. If it keeps failing, email support@crisper.io.",
    },
  );
}

/**
 * Map a tool error to a CLI error. The stable code in `_meta` decides; the
 * text is only shown for Crisper's own messages (the server sends a generic
 * text for anything else, code `internal`). Older servers send no code: then
 * the few exact texts they used are matched, and everything else is generic.
 */
/** The server appends this to every write error; for the CLI it's misleading or wrong. */
const WRITE_SUFFIX =
  / The change may have completed\. Check get_connection and list_sites before retrying a create request\.$/;

export function toolError(
  text: string,
  code: string | null,
  write: boolean,
): CliError {
  const message = safeText(text.trim().replace(WRITE_SUFFIX, ""));
  switch (code ?? legacyCode(text.trim())) {
    case "auth_required":
      return new CliError(
        "AUTH_EXPIRED",
        "Your sign-in is no longer accepted.",
        {
          exit: EXIT.auth,
          next: "Run `crisper login`.",
        },
      );
    case "not_enabled":
      return paused();
    case "unavailable":
      return transient(5);
    case "rate_limited":
      return rateLimited(60);
    case "site_unavailable":
      return notVisible();
    case "org_required":
      return new CliError("INVALID_ARGUMENT", "Choose an organization first.", {
        exit: EXIT.usage,
        next: "Run `crisper orgs use` to choose one, or pass --org.",
      });
    case "in_progress":
      return new CliError("SERVER_ERROR", message, {
        exit: EXIT.failure,
        retryable: true,
        retryAfterSeconds: 60,
        next: "Wait a minute, then check before retrying.",
      });
    // These two server texts name MCP tools; the CLI says it in its own words.
    case "tracking_not_ready":
      return new CliError(
        "CUSTOMER_ACTION_REQUIRED",
        "Tracking isn't set up for this website yet: Crisper creates the tracking domain once billing is active.",
        {
          exit: EXIT.customerAction,
          next: "Run `crisper sites status` to see the next step.",
        },
      );
    case "no_subscription":
      return new CliError(
        "CUSTOMER_ACTION_REQUIRED",
        "This website has no active subscription.",
        {
          exit: EXIT.customerAction,
          next: "Run `crisper billing status` to check.",
        },
      );
    case "domain_taken":
    case "integration_taken":
      return new CliError("CONFLICT", message, {
        exit: EXIT.denied,
        next: "Email support@crisper.io if this should belong to you.",
      });
    case "confirmation_invalid":
      return new CliError("INVALID_ARGUMENT", message, {
        exit: EXIT.usage,
        next: "Run the command again to get a fresh confirmation.",
      });
    case "invalid_argument":
      return new CliError("INVALID_ARGUMENT", message, {
        exit: EXIT.usage,
        next: "Check the values you passed and try again.",
      });
    case "failed":
      return write
        ? unconfirmed(message)
        : new CliError("SERVER_ERROR", message, { exit: EXIT.failure });
    default:
      return write ? unconfirmed(null) : generic();
  }
}

/** A write that failed may still have happened; never invite a blind retry. */
const CHECK_BEFORE_RETRY =
  "Check with `crisper sites status` or `crisper billing status` before trying again.";

function unconfirmed(message: string | null) {
  return new CliError(
    "WRITE_UNCONFIRMED",
    message ?? "Crisper couldn't confirm whether that change was made.",
    { exit: EXIT.unconfirmed, next: CHECK_BEFORE_RETRY },
  );
}

function abortError() {
  const error = new Error("Interrupted");
  error.name = "AbortError";
  return error;
}

/** Exact texts from servers older than the error-code release (before 0.3.04). */
const LEGACY: Record<string, string> = {
  "Authentication required.": "auth_required",
  "Authentication required or this client is not enabled.": "auth_required",
  "MCP is not enabled.": "not_enabled",
  "Crisper MCP is unavailable.": "not_enabled",
  "MCP origin is not configured.": "not_enabled",
  "Sign-in check is unavailable. Retry shortly.": "unavailable",
  "Rate limit reached. Retry in one minute.": "rate_limited",
  "Site or organization unavailable.": "site_unavailable",
  "Site unavailable.": "site_unavailable",
  "Organization access could not be verified.": "unavailable",
  "Pass websiteId from list_sites.": "invalid_argument",
};
function legacyCode(text: string): string | null {
  return LEGACY[text] ?? null;
}

async function once(
  origin: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  fetcher: typeof fetch,
  write: boolean,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const client = new Client({ name: "crisperio-cli", version: VERSION });
  const remembering: typeof fetch = async (input, init) => {
    // The SDK sets its own signal on each request; add ours so Ctrl-C reaches
    // every request, including the initialize handshake.
    const signals = [init?.signal, signal].filter(
      (s): s is AbortSignal => s instanceof AbortSignal,
    );
    const response = await fetcher(input, {
      ...init,
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
    });
    const retry = Number(response.headers.get("retry-after"));
    lastRetryAfter = Number.isFinite(retry) && retry > 0 ? retry : null;
    return response;
  };
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/api/mcp`),
    {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: remembering,
    },
  );
  try {
    if (signal?.aborted) throw abortError();
    await client.connect(transport, signal ? { signal } : undefined);
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      signal ? { signal } : undefined,
    );
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (result.isError) {
      const meta = result._meta as Record<string, unknown> | undefined;
      const code = meta?.[ERROR_CODE_META];
      throw toolError(text, typeof code === "string" ? code : null, write);
    }
    if (result.structuredContent !== undefined)
      return { data: result.structuredContent, requestId: null };
    try {
      return { data: JSON.parse(text), requestId: null };
    } catch {
      return { data: { text }, requestId: null };
    }
  } finally {
    await transport.close().catch(() => {});
  }
}

function isUnauthorized(error: unknown) {
  return error instanceof StreamableHTTPError && error.code === 401;
}

/**
 * Call one MCP tool. `write` marks tools that change something, so a failure
 * whose outcome is unknown exits 8 (check before retrying) instead of 1.
 */
export function callTool(
  ...args: Parameters<typeof callToolNow>
): ReturnType<typeof callToolNow> {
  return waiting(() => callToolNow(...args));
}

async function callToolNow(
  session: Session,
  origin: string,
  name: string,
  args: Record<string, unknown> = {},
  fetcher: typeof fetch = fetch,
  {
    write = false,
    signal,
  }: { write?: boolean; signal?: AbortSignal | undefined } = {},
): Promise<ToolResult> {
  try {
    return await once(
      origin,
      await session.accessToken(),
      name,
      args,
      fetcher,
      write,
      signal,
    );
  } catch (error) {
    if (!isUnauthorized(error))
      throw mapTransport(signal?.aborted ? abortError() : error, write);
  }
  try {
    return await once(
      origin,
      await session.accessToken({ forceRefresh: true }),
      name,
      args,
      fetcher,
      write,
      signal,
    );
  } catch (error) {
    if (isUnauthorized(error))
      throw new CliError(
        "AUTH_EXPIRED",
        "Your sign-in is no longer accepted.",
        {
          exit: EXIT.auth,
          next: "Run `crisper login`.",
        },
      );
    throw mapTransport(signal?.aborted ? abortError() : error, write);
  }
}

export function mapTransport(error: unknown, write = false): unknown {
  if (error instanceof CliError) return error;
  if (error instanceof Error && error.name === "AbortError")
    return new CliError("INTERRUPTED", "Interrupted.", {
      exit: EXIT.interrupted,
      // A change sent before Ctrl-C may still have been made.
      ...(write ? { next: CHECK_BEFORE_RETRY } : {}),
    });
  if (error instanceof StreamableHTTPError) {
    if (error.code === 429) return rateLimited(lastRetryAfter ?? 60);
    // The route sends Retry-After 5 for a brief sign-in check outage and 60 for the kill switch.
    if (error.code === 503) {
      const wait = lastRetryAfter ?? 60;
      return wait <= 10 ? transient(wait) : paused(wait);
    }
    if (error.code === 403)
      return new CliError("ACCESS_DENIED", "This login can't use that.", {
        exit: EXIT.denied,
      });
  }
  // A write that got no clear answer (dropped connection, timeout, 500,
  // garbled response) may have happened: never invite a blind retry. Statuses
  // above (429, 503, 403) are refused before the tool runs.
  if (write) return unconfirmed(null);
  if (error instanceof TypeError && /fetch/i.test(error.message))
    return new CliError("NETWORK_ERROR", "Could not reach Crisper.", {
      exit: EXIT.failure,
      retryable: true,
      next: "Check your connection and try again.",
    });
  return error;
}
