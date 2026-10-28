import { CliError, EXIT } from "../errors.js";

/**
 * OAuth device authorization grant (RFC 8628) against the discovered issuer.
 * The private device code never leaves this module; callers only see the
 * user-facing code and URL, then the resulting tokens.
 */
export type DeviceStart = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
  /** Opaque; passed back to pollForToken and never printed. */
  deviceCode: string;
};

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  /** Unix ms. */
  expiresAt: number;
  scope: string | null;
};

type Deps = {
  fetcher?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
};

const form = (fields: Record<string, string>) =>
  new URLSearchParams(fields).toString();

const network = (host: string) =>
  new CliError("NETWORK_ERROR", `Could not reach ${host}.`, {
    exit: EXIT.failure,
    retryable: true,
    next: "Check your connection and try again.",
  });

const notEnabled = () =>
  new CliError(
    "CAPABILITY_UNAVAILABLE",
    "CLI sign-in isn't enabled for this Crisper environment yet.",
    {
      exit: EXIT.unavailable,
      next: "Use the Crisper MCP in your AI client for now: https://crisper.io/mcp",
    },
  );

const cancelled = () =>
  new CliError("INTERRUPTED", "Sign-in cancelled.", {
    exit: EXIT.interrupted,
  });

const expired = () =>
  new CliError("AUTH_EXPIRED", "The sign-in code expired.", {
    exit: EXIT.auth,
    next: "Run `crisper login` again.",
  });

/** A sleep that ends early when the signal fires. */
export function abortableSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function postForm(
  url: string,
  fields: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form(fields),
      // A credential-bearing POST never follows a redirect to another host.
      redirect: "manual",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw error instanceof CliError ? error : network(new URL(url).host);
  }
  const body: unknown = await response.json().catch(() => ({}));
  return {
    status: response.status,
    body:
      body && typeof body === "object" ? (body as Record<string, unknown>) : {},
  };
}

export async function requestDeviceCode(
  args: {
    endpoint: string;
    clientId: string;
    scope: string;
    resource: string;
  },
  { fetcher = fetch, signal }: Deps = {},
): Promise<DeviceStart> {
  const { status, body } = await postForm(
    args.endpoint,
    { client_id: args.clientId, scope: args.scope, resource: args.resource },
    fetcher,
    signal,
  );
  if (status !== 200 || typeof body.device_code !== "string") {
    const error = typeof body.error === "string" ? body.error : "";
    if (
      ["invalid_client", "invalid_grant", "unauthorized_client"].includes(error)
    )
      throw notEnabled();
    throw new CliError("SERVER_ERROR", "Sign-in could not start.", {
      exit: EXIT.failure,
      retryable: true,
      next: "Try again in a minute.",
    });
  }
  if (
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string"
  )
    throw new CliError("SERVER_ERROR", "Sign-in could not start.", {
      exit: EXIT.failure,
      retryable: true,
    });
  // RFC 8628 makes expires_in required; the server's lifetime is the only one we honour.
  const expiresIn = Number(body.expires_in);
  const interval = body.interval === undefined ? 5 : Number(body.interval);
  if (
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    !Number.isFinite(interval) ||
    interval <= 0
  )
    throw new CliError("SERVER_ERROR", "Sign-in could not start.", {
      exit: EXIT.failure,
      retryable: true,
    });
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete:
      typeof body.verification_uri_complete === "string"
        ? body.verification_uri_complete
        : null,
    expiresIn,
    interval,
  };
}

export function tokenSetFrom(
  body: Record<string, unknown>,
  now: number,
): TokenSet | null {
  if (typeof body.access_token !== "string" || body.access_token.length === 0)
    return null;
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" && body.refresh_token.length > 0
        ? body.refresh_token
        : null,
    // No lifetime from the issuer is recorded as unknown (0), never invented.
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : 0,
    scope: typeof body.scope === "string" ? body.scope : null,
  };
}

/**
 * Poll until the customer approves or denies in the browser. Honors the
 * server's interval, backs off on slow_down, stops at expiry or on cancel,
 * and retries a failed network call with its own backoff (reset after any
 * answer from the server) while the code is still valid.
 */
export async function pollForToken(
  args: {
    tokenEndpoint: string;
    clientId: string;
    resource: string;
    start: DeviceStart;
    signal?: AbortSignal;
  },
  { fetcher = fetch, sleep = abortableSleep, now = Date.now }: Deps = {},
): Promise<TokenSet> {
  const signal = args.signal;
  const deadline = now() + args.start.expiresIn * 1000;
  let interval = args.start.interval;
  let networkFailures = 0;
  while (true) {
    if (signal?.aborted) throw cancelled();
    // RFC 8628: wait the interval before every poll, including the first.
    const backoff =
      networkFailures === 0 ? 0 : Math.min(2 ** networkFailures, 60);
    await sleep((interval + backoff) * 1000, signal);
    if (signal?.aborted) throw cancelled();
    if (now() >= deadline) throw expired();
    let result: { status: number; body: Record<string, unknown> };
    try {
      result = await postForm(
        args.tokenEndpoint,
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: args.start.deviceCode,
          client_id: args.clientId,
          resource: args.resource,
        },
        fetcher,
        signal,
      );
    } catch (error) {
      if (error instanceof CliError && error.code === "INTERRUPTED")
        throw error;
      networkFailures += 1;
      if (networkFailures > 5) throw error;
      continue;
    }
    networkFailures = 0;
    if (result.status === 200) {
      const tokens = tokenSetFrom(result.body, now());
      if (tokens) return tokens;
      throw new CliError("SERVER_ERROR", "Sign-in returned no token.", {
        exit: EXIT.failure,
        retryable: true,
      });
    }
    const error =
      typeof result.body.error === "string" ? result.body.error : "";
    switch (error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      case "access_denied":
        throw new CliError(
          "AUTH_DENIED",
          "Sign-in was denied in the browser.",
          {
            exit: EXIT.auth,
            next: "Run `crisper login` again and choose Allow.",
          },
        );
      case "expired_token":
        throw expired();
      case "invalid_client":
      case "invalid_grant":
      case "unauthorized_client":
        throw notEnabled();
      default:
        throw new CliError("SERVER_ERROR", "Sign-in failed.", {
          exit: EXIT.failure,
          retryable: true,
          next: "Run `crisper login` again.",
        });
    }
  }
}
