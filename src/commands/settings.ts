import type { Session } from "../auth/session.js";
import { CliError, EXIT } from "../errors.js";
import { callTool } from "../mcp/client.js";
import { safeText } from "../output.js";
import { confirm } from "../prompt.js";
import type { CommandContext } from "./context.js";
import { type TargetFlags, resolveSite } from "./target.js";

type Flags = TargetFlags & {
  yes?: boolean;
  preview?: boolean;
  confirmation?: string;
  inputStdin?: boolean;
  log?: string;
  at?: string;
  integration?: string;
  outgoing?: string;
  collection?: string;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Thin MCP client: all eligibility, state and payload handling stays on the server. */
export async function settingsCommand(
  ctx: CommandContext,
  session: Session,
  flags: Flags,
  tool: string,
) {
  const { site } = await resolveSite(ctx, session, flags);
  const write = tool.startsWith("update_") || tool === "resend_event";
  const input: Record<string, unknown> = { websiteId: site.websiteId };
  approvalFlagsOrThrow(flags);
  if (flags.confirmation) input.confirmation = flags.confirmation;
  if (tool.startsWith("update_")) {
    const raw = flags.inputStdin
      ? await ctx.prompter.stdin()
      : await ctx.prompter.secret("Change JSON (hidden; see --help): ");
    try {
      if (raw.length > 12000) throw new Error();
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      const obj = record(parsed);
      const allowed =
        tool === "update_site_settings"
          ? ["settings", "storefrontPassword"]
          : ["alerts"];
      if (Object.keys(obj).some((key) => !allowed.includes(key)))
        throw new Error();
      Object.assign(input, obj);
    } catch {
      throw new CliError(
        "INVALID_ARGUMENT",
        "Provide the documented change JSON object. Input is never echoed.",
        { exit: EXIT.usage },
      );
    }
  }
  if (tool === "resend_event" || tool === "get_resend_options") {
    if (!flags.log || (tool === "resend_event" && !flags.integration))
      throw new CliError(
        "INVALID_ARGUMENT",
        "Use --log and, for re-send, --integration.",
        { exit: EXIT.usage },
      );
    input.logId = flags.log;
    if (flags.at) {
      const seconds = Date.parse(flags.at) / 1000;
      if (!Number.isFinite(seconds))
        throw new CliError(
          "INVALID_ARGUMENT",
          "Use the log's ISO time with --at.",
          { exit: EXIT.usage },
        );
      input.logDateUnix = seconds;
    }
    if (flags.integration) input.integrationId = flags.integration;
    if (flags.outgoing) input.outgoingLogId = flags.outgoing;
    if (flags.collection) input.eventCollection = flags.collection;
  }
  return callWithApproval(ctx, session, tool, input, flags, write);
}

type ApprovalFlags = {
  yes?: boolean;
  preview?: boolean;
  confirmation?: string;
  inputStdin?: boolean;
};

export function approvalFlagsOrThrow(flags: ApprovalFlags) {
  if (flags.confirmation && (flags.preview || !flags.yes))
    throw new CliError(
      "INVALID_ARGUMENT",
      "Use --confirmation with --yes and identical input; do not combine it with --preview.",
      { exit: EXIT.usage },
    );
}

/**
 * Calls a tool; a write's preview is shown and approved (or returned with
 * --preview) before the same input is sent again with its confirmation.
 */
export async function callWithApproval(
  ctx: CommandContext,
  session: Session,
  tool: string,
  input: Record<string, unknown>,
  flags: ApprovalFlags,
  write: boolean,
) {
  let { data } = await callTool(
    session,
    ctx.config.origin,
    tool,
    input,
    ctx.fetcher,
    { write, signal: ctx.signal },
  );
  let d = record(data);
  if (write && d.status === "confirmation_required") {
    if (flags.confirmation || typeof d.confirmation !== "string")
      throw new CliError(
        "CAPABILITY_UNAVAILABLE",
        "The server did not return a confirmation.",
        { exit: EXIT.unavailable },
      );
    const changes = [safeText(JSON.stringify(d.changes)), safeText(d.note)];
    ctx.writer.err(changes.join("\n"));
    // A returned command must approve this exact nonce, never a fresh preview.
    const argv = (ctx.argv ?? []).filter(
      (arg) => arg !== "--yes" && arg !== "--preview",
    );
    const end = argv.indexOf("--");
    argv.splice(
      end === -1 ? argv.length : end,
      0,
      "--confirmation",
      d.confirmation,
    );
    try {
      await confirm(
        ctx.prompter,
        !flags.preview &&
          ctx.interactive &&
          !ctx.mode.json &&
          !flags.inputStdin,
        false,
        "Apply this change?",
        { changes, argv },
      );
    } catch (error) {
      if (error instanceof CliError && error.code === "CONFIRMATION_REQUIRED") {
        error.data = { ...d, ...record(error.data), changes: d.changes };
        if (flags.preview)
          return {
            data: error.data,
            human: () => safeText(JSON.stringify(error.data, null, 2)),
          };
      }
      throw error;
    }
    ({ data } = await callTool(
      session,
      ctx.config.origin,
      tool,
      { ...input, confirmation: d.confirmation },
      ctx.fetcher,
      { write: true, signal: ctx.signal },
    ));
    d = record(data);
  }
  if (
    write &&
    ![
      "updated",
      "accepted_or_already_observed",
      "rejected",
      "unknown",
    ].includes(String(d.status))
  )
    throw new CliError(
      "WRITE_UNCONFIRMED",
      "The server did not confirm the outcome. Inspect current settings or Logs before retrying.",
      { exit: EXIT.unconfirmed },
    );
  if (d.status === "unknown")
    throw Object.assign(
      new CliError(
        "WRITE_UNCONFIRMED",
        "Re-send outcome is unknown. Inspect Logs before retrying; do not blindly repeat it.",
        { exit: EXIT.unconfirmed },
      ),
      { data },
    );
  if (d.status === "rejected")
    throw Object.assign(
      new CliError(
        "NOT_OBSERVED",
        "The platform rejected the re-send. Inspect Logs before retrying.",
        { exit: EXIT.customerAction },
      ),
      { data },
    );
  return { data, human: () => safeText(JSON.stringify(data, null, 2)) };
}
