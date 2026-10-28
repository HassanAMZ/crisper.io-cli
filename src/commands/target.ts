import { type Session } from "../auth/session.js";
import { CliError, EXIT } from "../errors.js";
import { callTool } from "../mcp/client.js";
import { type CommandContext } from "./context.js";
import { fetchOrganizations } from "./orgs.js";

export type Site = {
  websiteId: string;
  domain: string;
  siteType: string;
  dashboardUrl: string | null;
};

export type TargetFlags = { org?: string; site?: string };

/**
 * Which organization a command acts on: --org, else the saved default, else
 * the only one. Several and no choice is a usage error, never a guess.
 */
export async function resolveOrg(
  ctx: CommandContext,
  session: Session,
  flag: string | undefined,
): Promise<string> {
  const chosen = flag ?? session.profile.defaultOrgId;
  if (chosen) return (ctx.resolved.orgId = chosen);
  const { organizations } = await fetchOrganizations(ctx, session);
  if (organizations.length === 1)
    return (ctx.resolved.orgId = organizations[0]!.orgId);
  if (organizations.length === 0)
    throw new CliError(
      "CUSTOMER_ACTION_REQUIRED",
      "This login has no Crisper organization yet.",
      {
        exit: EXIT.customerAction,
        next: "Create one at https://crisper.io/dashboard, then run this again.",
      },
    );
  throw new CliError("INVALID_ARGUMENT", "Choose an organization first.", {
    exit: EXIT.usage,
    next: "Run `crisper orgs use <orgId>` or pass --org.",
  });
}

export async function listSites(
  ctx: CommandContext,
  session: Session,
  orgId: string,
): Promise<{ orgId: string; sites: Site[]; truncated: boolean }> {
  const { data } = await callTool(
    session,
    ctx.config.origin,
    "list_sites",
    { orgId },
    ctx.fetcher,
    { signal: ctx.signal },
  );
  const d = data as { sites?: unknown; truncated?: unknown } | null;
  if (!d || !Array.isArray(d.sites))
    throw new CliError(
      "CAPABILITY_UNAVAILABLE",
      "Crisper answered in a shape this version of the CLI doesn't understand.",
      { exit: EXIT.unavailable, next: "Update the CLI: npx crisperio@latest" },
    );
  const sites = d.sites.flatMap((item): Site[] => {
    const s = item as Record<string, unknown> | null;
    if (!s || typeof s.websiteId !== "string" || typeof s.domain !== "string")
      return [];
    return [
      {
        websiteId: s.websiteId,
        domain: s.domain,
        siteType: typeof s.siteType === "string" ? s.siteType : "",
        dashboardUrl:
          typeof s.dashboardUrl === "string" ? s.dashboardUrl : null,
      },
    ];
  });
  return { orgId, sites, truncated: d.truncated === true };
}

/** `example.com`, `https://www.example.com/` and `EXAMPLE.com` name the same site. */
export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

/**
 * Which site a command acts on: --site (a websiteId or a domain), else the
 * saved default, else the organization's only site. A domain is matched only
 * inside the chosen organization, so a typo can never reach another tenant.
 */
export async function resolveSite(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags,
): Promise<{ orgId: string; site: Site }> {
  const orgId = await resolveOrg(ctx, session, flags.org);
  const wanted = flags.site ?? session.profile.defaultSiteId ?? null;
  const { sites, truncated } = await listSites(ctx, session, orgId);
  const found = (site: Site) => {
    ctx.resolved.siteId = site.websiteId;
    return { orgId, site };
  };
  if (!wanted) {
    // A truncated list may hide other sites, so "the only one" can't be trusted.
    if (sites.length === 1 && !truncated) return found(sites[0]!);
    const none = sites.length === 0 && !truncated;
    throw new CliError(
      none ? "CUSTOMER_ACTION_REQUIRED" : "INVALID_ARGUMENT",
      none
        ? "This organization has no websites yet."
        : "Choose a website first.",
      {
        exit: none ? EXIT.customerAction : EXIT.usage,
        next: none
          ? "Add one: crisper sites add <domain> --type <platform>"
          : "Run `crisper sites use <domain>` or pass --site.",
      },
    );
  }
  const byId = sites.find((s) => s.websiteId === wanted);
  if (byId) return found(byId);
  const domain = normalizeDomain(wanted);
  const byDomain = sites.find((s) => normalizeDomain(s.domain) === domain);
  if (byDomain) return found(byDomain);
  if (!flags.site)
    // The saved default came from `crisper sites use` in another organization.
    throw new CliError(
      "INVALID_ARGUMENT",
      "Your saved website belongs to a different organization.",
      {
        exit: EXIT.usage,
        next: "Pass --site, or run `crisper sites use <domain>` for this organization.",
      },
    );
  throw new CliError(
    "ACCESS_DENIED",
    truncated
      ? "That website isn't in the first 100 sites Crisper listed for this organization."
      : "That website isn't in this organization.",
    {
      exit: EXIT.denied,
      next: "Run `crisper sites list` to see your websites.",
    },
  );
}
