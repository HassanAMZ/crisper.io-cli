import type { Session } from "../auth/session.js";
import { CliError, EXIT } from "../errors.js";
import { callTool } from "../mcp/client.js";
import { type Envelope, safeText, table } from "../output.js";
import { record } from "../record.js";
import type { CommandContext } from "./context.js";
import { resolveOrg } from "./target.js";

/** The command's own tool for each members command (see tool-map.ts). */
export const MEMBERS_TOOLS = {
  list: "list_members",
  invite: "invite_member",
  revoke: "revoke_invite",
  role: "set_member_role",
} as const;

type Flags = { org?: string };

export type MembersRequest =
  | { operation: "list" }
  | { operation: "invite"; emails: string[]; admin: boolean }
  | { operation: "revoke"; target: string }
  | { operation: "role"; target: string; role: string };

const ROLES = ["member", "admin"] as const;

/** An ID or an email, sent in the field the server reads it from. */
const byEmailOr = (idField: string, target: string) =>
  target.includes("@") ? { email: target } : { [idField]: target };

function toolInput(request: MembersRequest): Record<string, unknown> {
  switch (request.operation) {
    case "list":
      return {};
    case "invite":
      return {
        emails: request.emails,
        role: request.admin ? "admin" : "member",
      };
    case "revoke":
      return byEmailOr("invitationId", request.target);
    case "role": {
      const role = request.role.trim().toLowerCase();
      if (!(ROLES as readonly string[]).includes(role))
        throw new CliError("INVALID_ARGUMENT", "Use role member or admin.", {
          exit: EXIT.usage,
        });
      return { ...byEmailOr("userId", request.target), role };
    }
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

const rows = (value: unknown) =>
  Array.isArray(value) ? value.map(record) : [];

function human(request: MembersRequest, data: unknown): string {
  const d = record(data);
  const lines: string[] = [];
  switch (request.operation) {
    case "list": {
      const members = rows(d.members);
      lines.push(
        members.length
          ? table([
              ["EMAIL", "NAME", "ROLE", "USER ID"],
              ...members.map((m) => [
                safeText(m.email),
                safeText(m.name),
                safeText(m.role),
                safeText(m.userId),
              ]),
            ])
          : "No members.",
      );
      const invitations = rows(d.invitations);
      if (invitations.length)
        lines.push(
          "",
          table([
            ["INVITED", "ROLE", "SENT", "INVITATION ID"],
            ...invitations.map((i) => [
              safeText(i.email),
              safeText(i.role),
              safeText(i.createdAt).slice(0, 10),
              safeText(i.invitationId),
            ]),
          ]),
        );
      if (d.truncated === true)
        lines.push("", "More exist; see the dashboard's Members page.");
      return lines.join("\n");
    }
    case "invite":
      for (const r of rows(d.results))
        lines.push(
          `${safeText(r.email)}: ${safeText(r.status)}${
            r.status === "failed" ? ` (${safeText(r.message)})` : ""
          }`,
        );
      break;
    case "revoke":
    case "role":
      lines.push(safeText(d.status));
      break;
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
  if (typeof d.note === "string") lines.push("", safeText(d.note));
  return lines.join("\n");
}

/** Thin MCP client: the server checks the admin rule, the emails and the guards. */
export async function membersCommand(
  ctx: CommandContext,
  session: Session,
  flags: Flags,
  request: MembersRequest,
) {
  const tool = MEMBERS_TOOLS[request.operation];
  const input = {
    orgId: await resolveOrg(ctx, session, flags.org),
    ...toolInput(request),
  };
  let data: unknown;
  try {
    ({ data } = await callTool(
      session,
      ctx.config.origin,
      tool,
      input,
      ctx.fetcher,
      { write: request.operation !== "list", signal: ctx.signal },
    ));
  } catch (error) {
    // The generic hint names sites and billing; members show in members list.
    if (error instanceof CliError && error.code === "WRITE_UNCONFIRMED")
      throw new CliError("WRITE_UNCONFIRMED", error.message, {
        exit: error.exit,
        next: "Run `crisper members list` before trying again.",
      });
    throw error;
  }
  return {
    data,
    human: (env: Envelope) => human(request, env.data),
  };
}
