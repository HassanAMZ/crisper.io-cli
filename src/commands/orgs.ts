import { type Session } from "../auth/session.js";
import { CliError, EXIT } from "../errors.js";
import { callTool } from "../mcp/client.js";
import { type Envelope, safeText, shellArg, table } from "../output.js";
import { confirm } from "../prompt.js";
import { isRecord, record } from "../record.js";
import { type CommandContext } from "./context.js";
import { siteAfterChoosingOrg } from "./target.js";

export type Organization = {
  orgId: string;
  name: string;
  role: string | null;
  siteCount: number | null;
};

/** The server's `get_connection` is the only source of which orgs a login may use. */
export async function fetchOrganizations(
  ctx: CommandContext,
  session: Session,
): Promise<{
  organizations: Organization[];
  userId: string | null;
  raw: unknown;
}> {
  const { data } = await callTool(
    session,
    ctx.config.origin,
    "get_connection",
    {},
    ctx.fetcher,
    { signal: ctx.signal },
  );
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { organizations?: unknown }).organizations)
  )
    throw new CliError(
      "CAPABILITY_UNAVAILABLE",
      "Crisper answered in a shape this version of the CLI doesn't understand.",
      { exit: EXIT.unavailable, next: "Update the CLI: npx crisperio@latest" },
    );
  const list = (data as { organizations: unknown[] }).organizations;
  const organizations = list.flatMap((item): Organization[] => {
    if (!isRecord(item)) return [];
    const o = item;
    if (typeof o.orgId !== "string") return [];
    return [
      {
        orgId: o.orgId,
        name: typeof o.name === "string" ? o.name : "",
        role: typeof o.role === "string" ? o.role : null,
        siteCount: typeof o.siteCount === "number" ? o.siteCount : null,
      },
    ];
  });
  const user = (data as { user?: { id?: unknown } }).user;
  return {
    organizations,
    // Clerk user ID of this sign-in; absent on servers before 0.3.04.
    userId: user && typeof user.id === "string" ? user.id : null,
    raw: data,
  };
}

export function orgsTable(
  organizations: Organization[],
  defaultOrgId: string | null,
) {
  if (organizations.length === 0)
    return "No organizations yet. Create one: crisper orgs create <business name>";
  return table([
    ["", "ORG ID", "NAME", "ROLE", "SITES"],
    ...organizations.map((o) => [
      o.orgId === defaultOrgId ? "*" : "",
      o.orgId,
      o.name,
      o.role ?? "",
      o.siteCount === null ? "?" : String(o.siteCount),
    ]),
  ]);
}

export async function orgsList(ctx: CommandContext, session: Session) {
  const { organizations } = await fetchOrganizations(ctx, session);
  await rememberNames(session, organizations);
  return {
    data: { organizations, defaultOrgId: session.profile.defaultOrgId },
    human: (env: Envelope) => {
      const d = env.data as {
        organizations: Organization[];
        defaultOrgId: string | null;
      };
      const lines = [orgsTable(d.organizations, d.defaultOrgId)];
      if (d.organizations.length > 1 && !d.defaultOrgId)
        lines.push("", "Pick one for later commands: crisper orgs use");
      return lines.join("\n");
    },
  };
}

/** Keep the saved organization's name current, for the interactive prompt. */
export async function rememberNames(
  session: Session,
  organizations: Organization[],
) {
  const name = organizations.find(
    (o) => o.orgId === session.profile.defaultOrgId,
  )?.name;
  if (name && name !== session.profile.defaultOrgName)
    await session.updateProfile({ defaultOrgName: name }).catch(() => {});
}

/** A person at a terminal who can answer an arrow-key list. */
export const canChoose = (ctx: CommandContext) =>
  ctx.interactive && !ctx.mode.json;

/** `orgs use` without an org ID only works where the list can be shown. */
export function requireOrgIdUnlessChoosing(
  ctx: CommandContext,
  orgId: string | undefined,
) {
  if (!orgId && !canChoose(ctx))
    throw new CliError("INVALID_ARGUMENT", "Name the organization to use.", {
      exit: EXIT.usage,
      next: "Run `crisper orgs use <orgId>`; `crisper orgs list` shows the IDs.",
    });
}

/** Ask which organization to use. Null when skipped. */
export function chooseOrganization(
  ctx: CommandContext,
  organizations: Organization[],
  current: string | null = null,
): Promise<string | null> {
  const names = organizations.map((o) => safeText(o.name) || "(no name)");
  const width = Math.max(...names.map((n) => n.length));
  const choices = organizations.map((o, i) => {
    const sites =
      o.siteCount === null
        ? ""
        : `${o.siteCount} site${o.siteCount === 1 ? "" : "s"}`;
    const now = o.orgId === current ? "  (current)" : "";
    return {
      label: `${names[i]!.padEnd(width)}  ${sites}${now}`.trimEnd(),
      value: o.orgId,
    };
  });
  return ctx.prompter.choose(
    "Which organization should later commands use?",
    choices,
  );
}

export async function orgsUse(
  ctx: CommandContext,
  session: Session,
  orgId: string | undefined,
) {
  requireOrgIdUnlessChoosing(ctx, orgId);
  const { organizations } = await fetchOrganizations(ctx, session);
  if (!orgId) {
    if (organizations.length === 0)
      throw new CliError("ACCESS_DENIED", orgsTable([], null), {
        exit: EXIT.denied,
      });
    const chosen = await chooseOrganization(
      ctx,
      organizations,
      session.profile.defaultOrgId,
    );
    if (!chosen)
      throw new CliError("INTERRUPTED", "Nothing was changed.", {
        exit: EXIT.interrupted,
      });
    orgId = chosen;
  }
  const match = organizations.find((o) => o.orgId === orgId);
  if (!match)
    throw new CliError(
      "ACCESS_DENIED",
      "That organization isn't one this login can use.",
      {
        exit: EXIT.denied,
        next: "Run `crisper orgs list` to see your organizations.",
      },
    );
  const sameOrg = match.orgId === session.profile.defaultOrgId;
  // At a terminal, the website comes next: that's where the work is.
  const site = await siteAfterChoosingOrg(
    ctx,
    session,
    match.orgId,
    sameOrg ? (session.profile.defaultSiteId ?? null) : null,
  );
  await session.updateProfile({
    defaultOrgId: match.orgId,
    defaultOrgName: match.name,
    // A site belongs to one organization; a new choice of org drops the old site.
    ...(site
      ? { defaultSiteId: site.websiteId, defaultSiteDomain: site.domain }
      : sameOrg
        ? {}
        : { defaultSiteId: null, defaultSiteDomain: null }),
  });
  return {
    data: {
      defaultOrgId: match.orgId,
      name: match.name,
      ...(site ? { defaultSiteId: site.websiteId, domain: site.domain } : {}),
    },
    context: {
      orgId: match.orgId,
      ...(site ? { siteId: site.websiteId } : {}),
    },
    human: () =>
      `Using ${safeText(match.name)} (${safeText(match.orgId)})${site ? ` and ${safeText(site.domain)}` : ""} for later commands.`,
  };
}

/**
 * Create an organization (the server reuses one this login already has with
 * the same name). A write: a typed yes at a terminal, or --yes after approval.
 * The organization, new or reused, becomes the default for later commands;
 * a saved website from another organization is forgotten.
 */
export async function orgsCreate(
  ctx: CommandContext,
  session: Session,
  rawName: string,
  flags: { yes: boolean },
) {
  const name = rawName.trim();
  if (name.length < 2 || name.length > 80)
    throw new CliError(
      "INVALID_ARGUMENT",
      "Use an organization name of 2 to 80 characters.",
      { exit: EXIT.usage },
    );
  const saved = session.profile.defaultSiteDomain;
  const changes = [
    `Create the organization ${safeText(name)}, or reuse yours with that name. No charge is made.`,
    `Later commands on this computer will use it${saved ? `; if it isn't the organization saved now, they stop using the saved website ${safeText(saved)}` : ""}.`,
  ];
  ctx.writer.err(changes.join("\n"));
  await confirm(
    ctx.prompter,
    ctx.interactive && !ctx.mode.json,
    flags.yes,
    "Create this organization?",
    { changes, argv: ctx.argv ?? [] },
  );
  // Whether an organization was made can only be read from the list of them.
  const unconfirmed = () =>
    new CliError(
      "WRITE_UNCONFIRMED",
      "Crisper couldn't confirm whether the organization was created.",
      {
        exit: EXIT.unconfirmed,
        next: "Run `crisper orgs list` before trying again.",
      },
    );
  let data: unknown;
  try {
    ({ data } = await callTool(
      session,
      ctx.config.origin,
      "create_organization",
      { name },
      ctx.fetcher,
      { write: true, signal: ctx.signal },
    ));
  } catch (error) {
    if (error instanceof CliError && error.code === "WRITE_UNCONFIRMED")
      throw unconfirmed();
    throw error;
  }
  const d = record(data);
  const orgId = typeof d.orgId === "string" ? d.orgId : null;
  if (!orgId) throw unconfirmed();
  const orgName = typeof d.name === "string" ? d.name : name;
  // Any saved website belongs to the previous default organization.
  let remembered = true;
  await session
    .updateProfile({
      defaultOrgId: orgId,
      defaultOrgName: orgName,
      ...(orgId !== session.profile.defaultOrgId
        ? { defaultSiteId: null, defaultSiteDomain: null }
        : {}),
    })
    .catch(() => {
      remembered = false;
    });
  // Name the organization, so the next step works even if saving the default failed.
  const next = `crisper sites add <domain> --type <platform> --org ${shellArg(orgId)}`;
  return {
    data: {
      ...d,
      orgId,
      name: orgName,
      defaultChanged: remembered,
      next: { step: "site", command: next },
    },
    context: { orgId },
    human: () =>
      [
        d.status === "exists"
          ? `You already have ${safeText(orgName)} (${safeText(orgId)}).`
          : `Created ${safeText(orgName)} (${safeText(orgId)}).`,
        remembered
          ? "Later commands now use it."
          : "Couldn't save it as the default on this computer; pass --org to later commands.",
        "",
        "Next: add a website.",
        `  ${next}`,
      ].join("\n"),
  };
}
