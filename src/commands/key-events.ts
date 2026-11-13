import type { Session } from "../auth/session.js";
import { CliError, EXIT } from "../errors.js";
import type { CommandContext } from "./context.js";
import { approvalFlagsOrThrow, callWithApproval } from "./settings.js";
import {
  type TargetFlags,
  listSites,
  normalizeDomain,
  resolveOrg,
  resolveSite,
} from "./target.js";

type Flags = TargetFlags & {
  events?: string;
  sites?: string;
  newSites?: boolean;
  yes?: boolean;
  preview?: boolean;
  confirmation?: string;
};

/** The command's own tool for each key-events command (see tool-map.ts). */
export const KEY_EVENTS_TOOLS = {
  get: "get_key_events",
  update: "update_key_events",
  default: "get_new_site_key_events",
  "set-default": "update_new_site_key_events",
  apply: "update_key_events_for_sites",
} as const;

export type KeyEventsOperation = keyof typeof KEY_EVENTS_TOOLS;

const ORG_OPERATIONS: readonly KeyEventsOperation[] = [
  "default",
  "set-default",
  "apply",
];

const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** Thin MCP client: the server checks the picks, the admin role and the sites. */
export async function keyEventsCommand(
  ctx: CommandContext,
  session: Session,
  flags: Flags,
  operation: KeyEventsOperation,
) {
  const tool = KEY_EVENTS_TOOLS[operation];
  const write = tool.startsWith("update_");
  approvalFlagsOrThrow(flags);
  const input: Record<string, unknown> = {};
  if (ORG_OPERATIONS.includes(operation))
    input.orgId = await resolveOrg(ctx, session, flags.org);
  else
    input.websiteId = (await resolveSite(ctx, session, flags)).site.websiteId;
  if (write) {
    if (!flags.events)
      throw new CliError(
        "INVALID_ARGUMENT",
        "Use --events with one or two key events, e.g. --events Purchase,SubmitApplication.",
        { exit: EXIT.usage },
      );
    input.keyEvents = list(flags.events);
  }
  if (operation === "apply") {
    if (flags.sites)
      input.websiteIds = await siteIds(
        ctx,
        session,
        String(input.orgId),
        list(flags.sites),
      );
    if (flags.newSites) input.includeNewSites = true;
  }
  if (flags.confirmation) input.confirmation = flags.confirmation;
  return callWithApproval(ctx, session, tool, input, flags, write);
}

/** --sites takes websiteIds or domains, matched only inside the organization. */
async function siteIds(
  ctx: CommandContext,
  session: Session,
  orgId: string,
  wanted: string[],
) {
  const { sites } = await listSites(ctx, session, orgId);
  return wanted.map((value) => {
    const found = sites.find(
      (site) =>
        site.websiteId === value ||
        normalizeDomain(site.domain) === normalizeDomain(value),
    );
    if (!found)
      throw new CliError(
        "INVALID_ARGUMENT",
        `No website ${value} in this organization.`,
        { exit: EXIT.usage, next: "Run `crisper sites list` to see them." },
      );
    return found.websiteId;
  });
}
