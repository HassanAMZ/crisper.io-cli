import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { type Session } from "../auth/session.js";
import { CliError, EXIT } from "../errors.js";
import { VERSION } from "../version.js";

/**
 * The CLI is one more MCP client. Every command is a tool call to
 * `<origin>/api/mcp` with the customer's own token; the server decides what
 * that token may see. A 401 gets one refresh and one retry, then exit 3.
 */
export type ToolResult = { data: unknown; requestId: string | null };

/** The SDK's error carries only the status; the server's Retry-After is kept here. */
let lastRetryAfter: number | null = null;

/**
 * Tool errors arrive as text. The server's messages are matched exactly
 * (`mcpError(...)` in convex/lib/mcpPolicy.ts, convex/mcp.ts, convex/mcpData.ts);
 * anything else is a generic failure, never guessed from substrings.
 */
const TOOL_ERRORS: Record<string, () => CliError> = {
  "Authentication required.": () =>
    new CliError("AUTH_EXPIRED", "Your sign-in is no longer accepted.", {
      exit: EXIT.auth,
      next: "Run `crisper login`.",
    }),
  "Authentication required or this client is not enabled.": () =>
    new CliError("ACCESS_DENIED", "Crisper refused this sign-in for the CLI.", {
      exit: EXIT.denied,
      next: "Run `crisper login` again. If it keeps failing, this environment hasn't enabled the CLI yet.",
    }),
  "MCP is not enabled.": paused,
  "Crisper MCP is unavailable.": paused,
  "MCP origin is not configured.": paused,
  "Sign-in check is unavailable. Retry shortly.": () => transient(5),
  "Rate limit reached. Retry in one minute.": () => rateLimited(60),
  "Site or organization unavailable.": notVisible,
  "Site unavailable.": notVisible,
  "Organization access could not be verified.": notVisible,
  "Operation unavailable.": () =>
    new CliError("CAPABILITY_UNAVAILABLE", "Crisper doesn't offer that here.", {
      exit: EXIT.unavailable,
    }),
  "Pass websiteId from list_sites.": () =>
    new CliError("INVALID_ARGUMENT", "Pick a site first.", {
      exit: EXIT.usage,
      next: "Run `crisper sites list` and pass --site <id>.",
    }),
};

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
  return new CliError(
    "SERVER_ERROR",
    "Crisper couldn't check your sign-in just now.",
    {
      exit: EXIT.failure,
      retryable: true,
      retryAfterSeconds,
      next: `Try again in ${retryAfterSeconds} seconds.`,
    },
  );
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
      next: "Check `crisper orgs list` and the --org or --site value.",
    },
  );
}

export function toolError(text: string): CliError {
  const known = TOOL_ERRORS[text.trim()];
  if (known) return known();
  return new CliError(
    "SERVER_ERROR",
    "Crisper could not complete that request.",
    {
      exit: EXIT.failure,
      next: "Check the values you passed. If it keeps failing, email support@crisper.io.",
    },
  );
}

async function once(
  origin: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<ToolResult> {
  const client = new Client({ name: "crisperio-cli", version: VERSION });
  const remembering: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init);
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
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (result.isError) throw toolError(text);
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

export async function callTool(
  session: Session,
  origin: string,
  name: string,
  args: Record<string, unknown> = {},
  fetcher: typeof fetch = fetch,
): Promise<ToolResult> {
  try {
    return await once(origin, await session.accessToken(), name, args, fetcher);
  } catch (error) {
    if (!isUnauthorized(error)) throw mapTransport(error);
  }
  try {
    return await once(
      origin,
      await session.accessToken({ forceRefresh: true }),
      name,
      args,
      fetcher,
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
    throw mapTransport(error);
  }
}

export function mapTransport(error: unknown): unknown {
  if (error instanceof CliError) return error;
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
  if (error instanceof TypeError && /fetch/i.test(error.message))
    return new CliError("NETWORK_ERROR", "Could not reach Crisper.", {
      exit: EXIT.failure,
      retryable: true,
      next: "Check your connection and try again.",
    });
  return error;
}
