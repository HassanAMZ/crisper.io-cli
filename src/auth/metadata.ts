import { CliError, EXIT } from "../errors.js";

/**
 * Everything the CLI needs to sign in comes from two public documents: the
 * MCP's protected-resource metadata (which authorization server, which
 * `resource` value to request) and that server's own metadata (endpoints).
 * Nothing is hard-coded, so dev, local and production all work the same way.
 */
export type AuthMetadata = {
  resource: string;
  issuer: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  scopesSupported: string[];
};

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const invalid = (what: string) =>
  new CliError(
    "METADATA_INVALID",
    `Crisper's sign-in settings look wrong (${what}).`,
    {
      exit: EXIT.unavailable,
      next: "Try again later. If it keeps failing, email support@crisper.io.",
    },
  );

async function fetchJson(
  url: string,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { accept: "application/json" },
      // Discovery decides where credentials go: a redirect is not followed.
      redirect: "manual",
    });
  } catch {
    throw new CliError(
      "NETWORK_ERROR",
      `Could not reach ${new URL(url).host}.`,
      {
        exit: EXIT.failure,
        retryable: true,
        next: "Check your connection and try again.",
      },
    );
  }
  if (!response.ok)
    throw invalid(`${new URL(url).pathname} answered ${response.status}`);
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object") throw invalid("not JSON");
  return body as Record<string, unknown>;
}

function sameOrigin(url: unknown, issuer: string): url is string {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).origin === new URL(issuer).origin;
  } catch {
    return false;
  }
}

function stripSlash(s: string) {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export async function discoverAuth(
  origin: string,
  fetcher: typeof fetch = fetch,
): Promise<AuthMetadata> {
  const prm = await fetchJson(
    `${origin}/.well-known/oauth-protected-resource/api/mcp`,
    fetcher,
  );
  const resource = prm.resource;
  if (typeof resource !== "string" || !resource.endsWith("/api/mcp"))
    throw invalid("resource");
  // The token must be minted for the origin we will send it to. A local
  // server may advertise the production resource (it has no public origin).
  const local = ["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
  if (!local && resource !== `${origin}/api/mcp`)
    throw invalid("resource origin");
  const servers = prm.authorization_servers;
  const issuerRaw = Array.isArray(servers) ? servers[0] : undefined;
  if (typeof issuerRaw !== "string") throw invalid("authorization server");
  const issuer = stripSlash(issuerRaw);
  if (!issuer.startsWith("https://"))
    throw invalid("authorization server scheme");

  const as = await fetchJson(
    `${issuer}/.well-known/oauth-authorization-server`,
    fetcher,
  );
  if (typeof as.issuer !== "string" || stripSlash(as.issuer) !== issuer)
    throw invalid("issuer mismatch");
  const grants = Array.isArray(as.grant_types_supported)
    ? as.grant_types_supported
    : [];
  if (!grants.includes(DEVICE_GRANT))
    throw invalid("device sign-in not offered");
  if (!sameOrigin(as.device_authorization_endpoint, issuer))
    throw invalid("device endpoint");
  if (!sameOrigin(as.token_endpoint, issuer)) throw invalid("token endpoint");
  const revocation = sameOrigin(as.revocation_endpoint, issuer)
    ? as.revocation_endpoint
    : null;
  const scopes = Array.isArray(prm.scopes_supported)
    ? prm.scopes_supported.filter((s): s is string => typeof s === "string")
    : [];
  return {
    resource,
    issuer,
    deviceAuthorizationEndpoint: as.device_authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    revocationEndpoint: revocation,
    scopesSupported: scopes,
  };
}
