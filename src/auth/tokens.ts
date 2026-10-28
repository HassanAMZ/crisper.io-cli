import { CliError, EXIT } from "../errors.js";
import { type TokenSet, tokenSetFrom } from "./device.js";

const form = (fields: Record<string, string>) =>
  new URLSearchParams(fields).toString();

/** Credential-bearing requests never follow a redirect: a 3xx is a failure. */
export const NO_REDIRECT = { redirect: "manual" } as const;

/** Nothing credential-related waits forever: a stalled issuer must not block cleanup. */
export const OAUTH_TIMEOUT_MS = 15_000;

/** Refresh with the public client's ID only. `invalid_grant` means the session is gone. */
export async function refreshTokens(
  args: {
    tokenEndpoint: string;
    clientId: string;
    refreshToken: string;
    resource: string;
  },
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<TokenSet> {
  let response: Response;
  try {
    response = await fetcher(args.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form({
        grant_type: "refresh_token",
        refresh_token: args.refreshToken,
        client_id: args.clientId,
        resource: args.resource,
      }),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      ...NO_REDIRECT,
    });
  } catch {
    throw new CliError("NETWORK_ERROR", "Could not refresh your sign-in.", {
      exit: EXIT.failure,
      retryable: true,
      next: "Check your connection and try again.",
    });
  }
  const body: unknown = await response.json().catch(() => ({}));
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (response.ok) {
    const tokens = tokenSetFrom(record, now());
    if (tokens)
      return {
        ...tokens,
        // A server that doesn't rotate keeps the old refresh token valid.
        refreshToken: tokens.refreshToken ?? args.refreshToken,
      };
  }
  if (
    record.error === "invalid_grant" ||
    response.status === 400 ||
    response.status === 401
  )
    throw new CliError(
      "AUTH_EXPIRED",
      "Your sign-in has expired or was revoked.",
      { exit: EXIT.auth, next: "Run `crisper login`." },
    );
  throw new CliError("SERVER_ERROR", "Could not refresh your sign-in.", {
    exit: EXIT.failure,
    retryable: true,
    next: "Try again in a minute.",
  });
}

/**
 * RFC 7009 revocation. Returns false when the server could not be reached or
 * refused; the caller still clears local credentials and reports
 * REVOCATION_UNCONFIRMED so a customer never believes a cache wipe was a revoke.
 */
export async function revokeToken(
  args: {
    revocationEndpoint: string;
    clientId: string;
    token: string;
    tokenTypeHint: "access_token" | "refresh_token";
  },
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(args.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        token: args.token,
        token_type_hint: args.tokenTypeHint,
        client_id: args.clientId,
      }),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      ...NO_REDIRECT,
    });
    return response.ok;
  } catch {
    return false;
  }
}
