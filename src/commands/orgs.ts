import { type Session } from "../auth/session.js";
import { CliError, EXIT } from "../errors.js";
import { callTool } from "../mcp/client.js";
import { type Envelope, safeText, table } from "../output.js";
import { type CommandContext } from "./context.js";

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
    if (!item || typeof item !== "object") return [];
    const o = item as Record<string, unknown>;
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
    return "No organizations yet. Create one at https://crisper.io/dashboard, then run this again.";
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
  await session.updateProfile({
    defaultOrgId: match.orgId,
    // A site belongs to one organization; a new choice of org drops the old site.
    ...(match.orgId !== session.profile.defaultOrgId
      ? { defaultSiteId: null }
      : {}),
  });
  return {
    data: { defaultOrgId: match.orgId, name: match.name },
    human: () =>
      `Using ${safeText(match.name)} (${safeText(match.orgId)}) for later commands.`,
  };
}
