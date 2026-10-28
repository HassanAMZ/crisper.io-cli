import { pollForToken, requestDeviceCode } from "../auth/device.js";
import { discoverAuth } from "../auth/metadata.js";
import {
  type SessionDeps,
  clearSession,
  hasSession,
  loadSession,
  saveSession,
} from "../auth/session.js";
import { secretName } from "../auth/store.js";
import { revokeToken } from "../auth/tokens.js";
import { requireClientId } from "../config.js";
import { CliError, EXIT } from "../errors.js";
import { type Envelope, safeText } from "../output.js";
import { type CommandContext, sessionOf } from "./context.js";
import { type Organization, fetchOrganizations, orgsTable } from "./orgs.js";

const depsOf = (ctx: CommandContext): SessionDeps => ({
  config: ctx.config,
  secrets: ctx.secrets,
  configs: ctx.configs,
  fetcher: ctx.fetcher,
  now: ctx.now,
});

/**
 * The approval link is shown and opened only when it is an https URL without
 * credentials on the issuer's own domain (Clerk hosts approval on a sibling
 * host such as accounts.<domain>). Anything else is refused: `open` on
 * Windows would hand a non-URL to `start`.
 */
export function approvalUrl(url: string, issuer: string): string | null {
  try {
    const u = new URL(url);
    const base = new URL(issuer).hostname.split(".").slice(-2).join(".");
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * `crisper login`: device sign-in. The verification URL and code go to stderr
 * so `--json` stdout stays a single envelope. The browser opens only when the
 * terminal is interactive and `--no-browser` was not given. A previous
 * sign-in for this origin is revoked first so no token is left behind, and a
 * sign-in that the MCP gate then refuses is revoked again rather than kept.
 */
export async function login(
  ctx: CommandContext,
  options: { browser: boolean },
) {
  const clientId = requireClientId(ctx.config);
  const deps = depsOf(ctx);
  // The previous sign-in's choices, kept only if the same person signs in again.
  const previous = (await ctx.configs.read()).profiles[ctx.config.origin];
  if (await hasSession(deps)) {
    try {
      await (await loadSession(deps)).signOut();
    } catch {
      await clearSession(deps).catch(() => {});
    }
  }

  const meta = await discoverAuth(ctx.config.origin, ctx.fetcher);
  const start = await requestDeviceCode(
    {
      endpoint: meta.deviceAuthorizationEndpoint,
      clientId,
      scope: ctx.config.scope,
      resource: meta.resource,
    },
    { fetcher: ctx.fetcher },
  );
  const verificationUri = approvalUrl(start.verificationUri, meta.issuer);
  const url =
    (start.verificationUriComplete &&
      approvalUrl(start.verificationUriComplete, meta.issuer)) ||
    verificationUri;
  if (!verificationUri || !url)
    throw new CliError(
      "METADATA_INVALID",
      "Crisper's sign-in page link looks wrong.",
      {
        exit: EXIT.unavailable,
        next: "Try again later. If it keeps failing, email support@crisper.io.",
      },
    );
  ctx.writer.err(
    [
      `Open ${verificationUri} and enter the code ${safeText(start.userCode)}`,
      `Or open this link: ${url}`,
      `This login can use every Crisper organization this account belongs to. Waiting for approval…`,
    ].join("\n"),
  );
  if (options.browser && ctx.interactive)
    await ctx.openBrowser(url).catch(() => {});

  const tokens = await pollForToken(
    {
      tokenEndpoint: meta.tokenEndpoint,
      clientId,
      resource: meta.resource,
      start,
      signal: ctx.signal,
    },
    { fetcher: ctx.fetcher, now: ctx.now, signal: ctx.signal },
  );
  try {
    await saveSession(deps, {
      issuer: meta.issuer,
      clientId,
      resource: meta.resource,
      tokenEndpoint: meta.tokenEndpoint,
      revocationEndpoint: meta.revocationEndpoint,
      tokens,
    });
  } catch (error) {
    // Clerk has already issued the tokens: never leave them live unstored.
    if (meta.revocationEndpoint)
      for (const [token, hint] of [
        [tokens.refreshToken, "refresh_token"],
        [tokens.accessToken, "access_token"],
      ] as const)
        if (token)
          await revokeToken(
            {
              revocationEndpoint: meta.revocationEndpoint,
              clientId,
              token,
              tokenTypeHint: hint,
            },
            ctx.fetcher,
          );
    throw error;
  }

  // Prove the token at the real gate and learn which orgs it may use.
  const session = await sessionOf(ctx);
  let organizations: Organization[];
  let userId: string | null;
  try {
    ({ organizations, userId } = await fetchOrganizations(ctx, session));
  } catch (error) {
    await session.signOut().catch(() => clearSession(deps));
    throw error;
  }
  const samePerson =
    userId !== null && previous?.subject != null && previous.subject === userId;
  const previousOrg =
    samePerson && organizations.some((o) => o.orgId === previous?.defaultOrgId)
      ? (previous?.defaultOrgId ?? null)
      : null;
  // Only an unambiguous choice is made for the customer.
  const keep =
    organizations.length === 1 ? organizations[0]!.orgId : previousOrg;
  await session.updateProfile({
    subject: userId,
    defaultOrgId: keep,
    defaultSiteId:
      samePerson && keep === previous?.defaultOrgId
        ? (previous?.defaultSiteId ?? null)
        : null,
  });

  return {
    data: {
      signedIn: true,
      origin: ctx.config.origin,
      organizations,
      defaultOrgId: keep,
    },
    human: (env: Envelope) => {
      const d = env.data as {
        organizations: Organization[];
        defaultOrgId: string | null;
      };
      const lines = [
        `Signed in to Crisper (${new URL(ctx.config.origin).host}).`,
        "",
        orgsTable(d.organizations, d.defaultOrgId),
      ];
      if (d.organizations.length > 1 && !d.defaultOrgId)
        lines.push("", "Pick one for later commands: crisper orgs use <orgId>");
      return lines.join("\n");
    },
  };
}

export async function status(ctx: CommandContext) {
  const session = await sessionOf(ctx);
  const p = session.profile;
  const data = {
    signedIn: true,
    origin: p.origin,
    signedInAt: p.signedInAt,
    accessTokenExpiresAt: new Date(p.expiresAt).toISOString(),
    canRefresh: Boolean(
      await ctx.secrets.get(secretName(p.origin, p.clientId, "refresh")),
    ),
    defaultOrgId: p.defaultOrgId,
    defaultSiteId: p.defaultSiteId ?? null,
  };
  return {
    data,
    human: () =>
      [
        `Signed in to Crisper (${new URL(p.origin).host}) since ${p.signedInAt}.`,
        data.defaultOrgId
          ? `Default organization: ${safeText(data.defaultOrgId)}`
          : "No default organization. Run `crisper orgs use <orgId>`.",
        ...(data.defaultSiteId
          ? [`Default website: ${safeText(data.defaultSiteId)}`]
          : []),
      ].join("\n"),
  };
}

export async function logout(ctx: CommandContext) {
  const session = await sessionOf(ctx);
  const confirmed = await session.signOut();
  if (!confirmed)
    throw new CliError(
      "REVOCATION_UNCONFIRMED",
      "Signed out on this computer, but Crisper could not confirm the sign-in was revoked.",
      {
        exit: EXIT.unconfirmed,
        retryable: true,
        next: "When you're back online, sign in at https://crisper.io and remove the CLI under your account's connected apps.",
      },
    );
  return {
    data: { signedOut: true, revoked: true },
    human: () => "Signed out. The sign-in was revoked.",
  };
}
