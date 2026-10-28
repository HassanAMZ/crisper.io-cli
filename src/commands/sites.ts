import { type Session } from "../auth/session.js";
import { CliError, EXIT } from "../errors.js";
import { callTool } from "../mcp/client.js";
import { safeText, shellArg, table } from "../output.js";
import { confirm } from "../prompt.js";
import { type CommandContext } from "./context.js";
import { humanStatus } from "./setup.js";
import { canChoose } from "./orgs.js";
import {
  type TargetFlags,
  chooseSite,
  listSites,
  normalizeDomain,
  resolveOrg,
  resolveSite,
} from "./target.js";

/** Platforms Crisper accepts (data/platforms.ts on the server; it validates too). */
export const SITE_TYPES = [
  "wordpress",
  "clickfunnels",
  "kajabi",
  "shopify",
  "medusa",
  "magento",
  "bigCommerce",
  "prestaShop",
  "wix",
  "salla",
  "webflow",
  "squarespace",
  "treez",
  "blaze",
  "dutchie",
  "other",
] as const;

const rec = (v: unknown) =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === "string" ? v : null);

export async function sitesList(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags,
) {
  const orgId = await resolveOrg(ctx, session, flags.org);
  const result = await listSites(ctx, session, orgId);
  const current = session.profile.defaultSiteId ?? null;
  const domain = result.sites.find((s) => s.websiteId === current)?.domain;
  if (domain && domain !== session.profile.defaultSiteDomain)
    await session.updateProfile({ defaultSiteDomain: domain }).catch(() => {});
  return {
    data: { ...result, defaultSiteId: current },
    context: { orgId },
    human: () => {
      if (result.sites.length === 0)
        return "No websites yet. Add one: crisper sites add <domain> --type <platform>";
      const lines = [
        table([
          ["", "SITE ID", "DOMAIN", "PLATFORM"],
          ...result.sites.map((s) => [
            s.websiteId === current ? "*" : "",
            s.websiteId,
            s.domain,
            s.siteType,
          ]),
        ]),
      ];
      if (result.truncated)
        lines.push(
          "",
          "Only the first 100 websites are listed; see the dashboard for the rest.",
        );
      return lines.join("\n");
    },
  };
}

/** `sites use` without a website only works where the list can be shown. */
export function requireSiteUnlessChoosing(
  ctx: CommandContext,
  site: string | undefined,
) {
  if (!site && !canChoose(ctx))
    throw new CliError("INVALID_ARGUMENT", "Name the website to use.", {
      exit: EXIT.usage,
      next: "Run `crisper sites use <domain>`; `crisper sites list` shows them.",
    });
}

export async function sitesUse(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags & { site?: string },
) {
  requireSiteUnlessChoosing(ctx, flags.site);
  let picked = flags.site;
  if (!picked) {
    const orgId = await resolveOrg(ctx, session, flags.org);
    const { sites } = await listSites(ctx, session, orgId);
    if (sites.length === 0)
      throw new CliError(
        "CUSTOMER_ACTION_REQUIRED",
        "This organization has no websites yet.",
        {
          exit: EXIT.customerAction,
          next: "Add one: crisper sites add <domain> --type <platform>",
        },
      );
    const chosen = await chooseSite(
      ctx,
      sites,
      session.profile.defaultSiteId ?? null,
    );
    if (!chosen)
      throw new CliError("INTERRUPTED", "Nothing was changed.", {
        exit: EXIT.interrupted,
      });
    picked = chosen;
  }
  const { orgId, site } = await resolveSite(ctx, session, {
    ...flags,
    site: picked,
  });
  await session.updateProfile({
    defaultOrgId: orgId,
    // --org may name another organization; its name isn't known here.
    ...(orgId !== session.profile.defaultOrgId ? { defaultOrgName: null } : {}),
    defaultSiteId: site.websiteId,
    defaultSiteDomain: site.domain,
  });
  return {
    data: {
      defaultOrgId: orgId,
      defaultSiteId: site.websiteId,
      domain: site.domain,
    },
    context: { orgId, siteId: site.websiteId },
    human: () => `Using ${safeText(site.domain)} for later commands.`,
  };
}

type Setup = {
  billing: boolean;
  domainVerified: boolean;
  scriptsGenerated: boolean;
  integrationAttached: boolean;
};

/** The one next step, in the product's order: billing, DNS, script, integrations. */
export function nextStep(setup: Setup, domain: string, orgId?: string) {
  // Name the org too, so the command works whatever org is saved as default.
  const site = `${orgId ? `--org ${shellArg(orgId)} ` : ""}--site ${shellArg(domain)}`;
  if (!setup.billing)
    return {
      step: "billing",
      command: `crisper billing link ${site}`,
      text: "Start billing for this website.",
    };
  if (!setup.domainVerified)
    return {
      step: "dns",
      command: `crisper dns records ${site}`,
      text: "Add the DNS records for the tracking domain, then run `crisper dns check`.",
    };
  if (!setup.scriptsGenerated)
    return {
      step: "install",
      command: `crisper install snippet ${site}`,
      text: "Add the tracking script to the website.",
    };
  if (!setup.integrationAttached)
    return {
      step: "integrations",
      command: `crisper integrations connect ${site} --platform meta --pixel <id>`,
      text: "Connect Meta or TikTok.",
    };
  return {
    step: "verify",
    command: `crisper events verify ${site} --type purchase`,
    text: "Send a test purchase or lead and check that Crisper received it.",
  };
}

export async function sitesStatus(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags,
) {
  const { orgId, site } = await resolveSite(ctx, session, flags);
  const { data } = await callTool(
    session,
    ctx.config.origin,
    "get_site_setup",
    { websiteId: site.websiteId },
    ctx.fetcher,
    { signal: ctx.signal },
  );
  const d = rec(data);
  const s = rec(d.setup);
  const setup: Setup = {
    billing: s.billing === true,
    domainVerified: s.domainVerified === true,
    scriptsGenerated: s.scriptsGenerated === true,
    integrationAttached: s.integrationAttached === true,
  };
  const next = nextStep(setup, site.domain, orgId);
  // Older servers send no billingDisplayStatus; fall back to the raw status.
  const billingLabel =
    humanStatus(d.billingDisplayStatus) ?? humanStatus(d.billingStatus);
  return {
    data: {
      websiteId: site.websiteId,
      orgId,
      domain: site.domain,
      setup,
      billingStatus: str(d.billingStatus),
      billingDisplayStatus: str(d.billingDisplayStatus),
      next,
      note: str(d.note),
    },
    context: { orgId, siteId: site.websiteId },
    human: () => {
      const mark = (ok: boolean) => (ok ? "done" : "to do");
      return [
        `${safeText(site.domain)}`,
        table([
          ["STEP", "STATE"],
          [
            "Billing",
            `${mark(setup.billing)}${billingLabel ? ` (${safeText(billingLabel)})` : ""}`,
          ],
          ["DNS records", mark(setup.domainVerified)],
          [
            "Tracking script",
            setup.scriptsGenerated
              ? "generated (not proof it's installed)"
              : "to do",
          ],
          ["Meta / TikTok", setup.integrationAttached ? "connected" : "to do"],
        ]),
        "",
        `Next: ${next.text}`,
        `  ${next.command}`,
      ].join("\n");
    },
  };
}

export async function sitesHealth(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags,
) {
  const { site } = await resolveSite(ctx, session, flags);
  const { data } = await callTool(
    session,
    ctx.config.origin,
    "get_site_health",
    { websiteId: site.websiteId },
    ctx.fetcher,
    { signal: ctx.signal },
  );
  const d = rec(data);
  const c = rec(d.conversions);
  const today = rec(c.today);
  const week = rec(c.rolling7Days);
  const n = (v: unknown) => (typeof v === "number" ? String(v) : "unknown");
  const asOf =
    typeof c.asOf === "number" ? new Date(c.asOf).toISOString() : null;
  return {
    data,
    human: () =>
      [
        `${safeText(site.domain)}: ${safeText(d.status ?? "unknown")}`,
        table([
          ["", "PURCHASES", "LEADS"],
          [
            `Today${today.date ? ` (${safeText(today.date)})` : ""}`,
            n(today.purchases),
            n(today.leads),
          ],
          [
            week.startDate && week.endDate
              ? `${safeText(week.startDate)} to ${safeText(week.endDate)}`
              : "Last 7 site days",
            n(week.purchases),
            n(week.leads),
          ],
        ]),
        "",
        `Cached counts${asOf ? ` from ${asOf}` : ""}${c.timezone ? `, site timezone ${safeText(c.timezone)}` : ""}. They are what Crisper received, not what Meta or TikTok accepted.`,
      ].join("\n"),
  };
}

export type AddFlags = TargetFlags & {
  type: string;
  timezone?: string;
  currency?: string;
  restricted: boolean;
  yes: boolean;
};

/** The computer's timezone, or UTC when it has none (founder default, 28 Oct). */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export async function sitesAdd(
  ctx: CommandContext,
  session: Session,
  rawDomain: string,
  flags: AddFlags,
) {
  if (!(SITE_TYPES as readonly string[]).includes(flags.type))
    throw new CliError(
      "INVALID_ARGUMENT",
      `Unknown platform "${safeText(flags.type)}".`,
      {
        exit: EXIT.usage,
        next: `Use one of: ${SITE_TYPES.join(", ")}.`,
      },
    );
  const orgId = await resolveOrg(ctx, session, flags.org);
  const domain = normalizeDomain(rawDomain);
  const settings = {
    domain,
    siteType: flags.type,
    timezone: flags.timezone ?? localTimezone(),
    currency: (flags.currency ?? "USD").toUpperCase(),
    restricted: flags.restricted,
  };
  const changes = [
    `Add ${safeText(domain)} to organization ${safeText(orgId)}: ${safeText(settings.siteType)}, ${safeText(settings.currency)}, ${safeText(settings.timezone)}, ${settings.restricted ? "restricted category on" : "restricted category off"}. No charge is made.`,
  ];
  ctx.writer.err(changes.join("\n"));
  await confirm(
    ctx.prompter,
    ctx.interactive && !ctx.mode.json,
    flags.yes,
    "Add this website?",
    {
      changes,
      argv: ctx.argv ?? [],
    },
  );
  const { data } = await callTool(
    session,
    ctx.config.origin,
    "create_site",
    { orgId, ...settings },
    ctx.fetcher,
    { write: true, signal: ctx.signal },
  );
  const d = rec(data);
  const websiteId = str(d.websiteId);
  if (!websiteId)
    throw new CliError(
      "WRITE_UNCONFIRMED",
      "Crisper didn't confirm the new website.",
      {
        exit: EXIT.unconfirmed,
        next: "Run `crisper sites list` before trying again.",
      },
    );
  // The new site becomes the default only when no --org override was given,
  // so a one-off add for another client doesn't redirect later commands.
  // The site exists either way: a failed config write must not report failure.
  let remembered = !flags.org;
  if (remembered)
    await session
      .updateProfile({
        defaultOrgId: orgId,
        defaultSiteId: websiteId,
        defaultSiteDomain: domain,
      })
      .catch(() => {
        remembered = false;
      });
  return {
    data: {
      websiteId,
      orgId,
      domain: str(d.domain) ?? domain,
      settings,
      replay: d.replay === true,
      defaultChanged: remembered,
      next: {
        step: "billing",
        command: `crisper billing link --org ${shellArg(orgId)} --site ${shellArg(domain)}`,
      },
    },
    context: { orgId, siteId: websiteId },
    human: () =>
      [
        d.replay === true
          ? `${safeText(domain)} was already in this organization.`
          : `Added ${safeText(domain)}.`,
        ...(remembered ? [`Later commands now use ${safeText(domain)}.`] : []),
        "",
        "Next: start billing. Crisper creates the tracking domain once billing is active.",
        `  crisper billing link --org ${shellArg(orgId)} --site ${shellArg(domain)}`,
      ].join("\n"),
  };
}
