import { type Session } from "../auth/session.js";
import { CliError, EXIT } from "../errors.js";
import { callTool } from "../mcp/client.js";
import { safeScript, safeText, shellArg, table } from "../output.js";
import { confirm } from "../prompt.js";
import { type CommandContext } from "./context.js";
import { type TargetFlags, resolveSite } from "./target.js";

const rec = (v: unknown) =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === "string" ? v : null);
/** `trial_ending` → `trial ending`; other statuses print as sent. */
export const humanStatus = (v: unknown) => str(v)?.replace(/_/g, " ") ?? null;

async function siteCall(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags,
  tool: string,
  args: Record<string, unknown> = {},
  write = false,
) {
  const { orgId, site } = await resolveSite(ctx, session, flags);
  const { data } = await callTool(
    session,
    ctx.config.origin,
    tool,
    { websiteId: site.websiteId, ...args },
    ctx.fetcher,
    { write, signal: ctx.signal },
  );
  return { orgId, site, d: rec(data), data };
}

/** A failure that still carries what the server said, for the JSON envelope. */
function withData(error: CliError, data: unknown) {
  error.data = data;
  return error;
}

// ---- DNS -----------------------------------------------------------------

const DNS_STATE: Record<string, string> = {
  not_created: "not created yet (Crisper creates it once billing is active)",
  waiting: "waiting for the records",
  https_error: "records found, HTTPS certificate failing",
  verified: "verified",
};

function dnsHuman(d: Record<string, unknown>) {
  const records = Array.isArray(d.records) ? d.records.map(rec) : [];
  const state = str(d.state) ?? "unknown";
  const lines = [
    `Tracking domain: ${safeText(d.trackingDomain ?? "not created")}`,
    `State: ${safeText(DNS_STATE[state] ?? state)}${d.problem ? ` (${safeText(d.problem)})` : ""}`,
  ];
  if (records.length)
    lines.push(
      "",
      table([
        ["TYPE", "HOST", "VALUE"],
        ...records.map((r) => [
          str(r.type) ?? "",
          str(r.host) ?? "",
          str(r.value) ?? "",
        ]),
      ]),
      "",
      d.state === "verified"
        ? "These records are in place and verified."
        : "Add these at your DNS provider exactly as shown, then run `crisper dns check`.",
    );
  return lines.join("\n");
}

/** Exit 6 while there is nothing to add yet (no tracking domain before billing). */
export async function dnsRecords(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags,
) {
  const { site, d, data } = await siteCall(
    ctx,
    session,
    flags,
    "get_dns_records",
  );
  const records = Array.isArray(d.records) ? d.records : [];
  if (
    d.state === "not_created" ||
    (records.length === 0 && d.state !== "verified")
  )
    throw withData(
      new CliError(
        "CUSTOMER_ACTION_REQUIRED",
        "There are no DNS records yet: Crisper creates the tracking domain once billing is active, which can take a few minutes after paying.",
        {
          exit: EXIT.customerAction,
          next: `Check billing with \`crisper billing status --org ${shellArg(ctx.resolved.orgId ?? "")} --site ${shellArg(site.domain)}\`; if it's active, run \`crisper dns records\` again in a few minutes.`,
        },
      ),
      data,
    );
  return { data, human: () => dnsHuman(d) };
}

/** Exit 6 until verified, so a script can loop on `crisper dns check`. */
export async function dnsCheck(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags,
) {
  const { d, data } = await siteCall(ctx, session, flags, "check_dns");
  if (d.state !== "verified") {
    const state = str(d.state) ?? "unknown";
    throw withData(
      new CliError(
        "CUSTOMER_ACTION_REQUIRED",
        `The tracking domain isn't verified yet: ${safeText(DNS_STATE[state] ?? state)}${d.problem ? ` (${safeText(d.problem)})` : ""}.`,
        {
          exit: EXIT.customerAction,
          retryable: true,
          next:
            state === "not_created"
              ? "Start billing first: crisper billing link"
              : "Check the records with `crisper dns records`. DNS can take minutes to hours to spread; run `crisper dns check` again later.",
        },
      ),
      data,
    );
  }
  return { data, human: () => dnsHuman(d) };
}

// ---- Install snippet ------------------------------------------------------

export async function installSnippet(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags,
) {
  const { d, data } = await siteCall(
    ctx,
    session,
    flags,
    "get_install_snippet",
  );
  return {
    data,
    human: () => {
      const steps = Array.isArray(d.steps) ? d.steps.map(rec) : [];
      const app = d.installPath === "app" && steps.length > 0;
      const lines = [
        `${safeText(d.platformLabel ?? d.platform ?? "")}: ${app ? "install with the Stape app" : "paste the scripts"}`,
      ];
      steps.forEach((s, i) => {
        lines.push("", `${i + 1}. ${safeText(s.title)} (${safeText(s.where)})`);
        for (const v of Array.isArray(s.values) ? s.values.map(rec) : [])
          lines.push(`   ${safeText(v.field)}: ${safeText(v.value ?? "")}`);
        for (const n of Array.isArray(s.notes) ? s.notes.map(rec) : [])
          lines.push(`   ${safeText(n.label)}: ${safeText(n.text)}`);
        for (const t of Array.isArray(s.turnOn) ? s.turnOn : [])
          lines.push(`   Turn on: ${safeText(t)}`);
        if (s.finish) lines.push(`   ${safeText(s.finish)}`);
      });
      if (d.closingHint) lines.push("", safeText(d.closingHint));
      const scripts = [];
      if (d.headScript)
        scripts.push(
          "",
          "Add inside <head>:",
          "",
          safeScript(String(d.headScript)),
        );
      if (d.bodyScript)
        scripts.push(
          "",
          "Add right after <body>:",
          "",
          safeScript(String(d.bodyScript)),
        );
      if (scripts.length) {
        // With an app install the scripts are a fallback, not an extra step.
        if (app)
          lines.push("", "Only if you can't use the app, paste these instead:");
        lines.push(...scripts);
      }
      lines.push(
        "",
        "Then send a test purchase or lead and run `crisper events verify --type purchase`.",
      );
      return lines.join("\n");
    },
  };
}

// ---- Events ---------------------------------------------------------------

export const EVENT_TYPES: Record<string, "Purchase" | "GenerateLead"> = {
  purchase: "Purchase",
  lead: "GenerateLead",
};

function eventOf(type: string | undefined) {
  if (type === undefined) return undefined;
  const event = EVENT_TYPES[type.toLowerCase()];
  if (!event)
    throw new CliError(
      "INVALID_ARGUMENT",
      `Unknown event type "${safeText(type)}".`,
      { exit: EXIT.usage, next: "Use --type purchase or --type lead." },
    );
  return event;
}

export async function eventsList(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags & { type?: string; limit?: string },
) {
  const event = eventOf(flags.type);
  const limit = flags.limit === undefined ? 20 : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new CliError("INVALID_ARGUMENT", "--limit must be 1 to 50.", {
      exit: EXIT.usage,
    });
  const { site, d, data } = await siteCall(
    ctx,
    session,
    flags,
    "list_recent_events",
    {
      ...(event ? { event } : {}),
      limit,
    },
  );
  return {
    data,
    human: () => {
      const events = Array.isArray(d.events) ? d.events.map(rec) : [];
      if (!events.length)
        return `No saved events for ${safeText(site.domain)} yet. Saved ${safeText(d.savedAt ?? "never")}.`;
      const delivery = (e: Record<string, unknown>) => {
        if (!e.delivery) return "";
        const del = rec(e.delivery);
        if (del.status === "gap")
          return `gap: ${(Array.isArray(del.missing)
            ? del.missing.map(rec)
            : []
          )
            .map((m) => `${safeText(m.integration)} ${safeText(m.kind)}`)
            .join(", ")}`;
        return safeText(del.status);
      };
      return [
        table([
          ["TIME", "EVENT", "STATUS", "DELIVERY"],
          ...events.map((e) => [
            str(e.time) ?? "",
            str(e.event) ?? "",
            str(e.receivedStatus) ?? "",
            delivery(e),
          ]),
        ]),
        "",
        `Saved ${safeText(d.savedAt ?? "never")}. Purchases and leads are saved about every 15 minutes.`,
        ...(d.truncated === true
          ? ["More events exist; raise --limit (up to 50)."]
          : []),
      ].join("\n");
    },
  };
}

const MAX_WAIT_MINUTES = 10;
const POLL_MS = 60_000;

/**
 * Did Crisper receive a test Purchase or Lead? Asks Stape live; with --wait,
 * asks again once a minute (the server's hint) until found or time is up.
 *
 * The window is frozen when the check starts, on the server's clock: the
 * cutoff is `since` minutes before the start, shifted by the server's clock
 * skew (from `checkedAt`); each later poll asks far enough back
 * to reach it, and an event older than it never counts. A retryable error
 * (the shared 6-a-minute live limit, a brief outage) waits and tries again
 * within the deadline. Exit 0 found, 6 not found, 7 when Stape's answer was
 * partial so absence can't be told.
 */
export async function eventsVerify(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags & { type?: string; since?: string; wait?: string },
) {
  const event = eventOf(flags.type);
  if (!event)
    throw new CliError("INVALID_ARGUMENT", "Say which event to check.", {
      exit: EXIT.usage,
      next: "Use --type purchase or --type lead.",
    });
  const since = flags.since === undefined ? 30 : Number(flags.since);
  if (!Number.isInteger(since) || since < 1 || since > 1440)
    throw new CliError(
      "INVALID_ARGUMENT",
      "--since must be 1 to 1440 minutes.",
      {
        exit: EXIT.usage,
      },
    );
  const wait = flags.wait === undefined ? 0 : Number(flags.wait);
  if (!Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_MINUTES)
    throw new CliError(
      "INVALID_ARGUMENT",
      `--wait must be 0 to ${MAX_WAIT_MINUTES} minutes.`,
      { exit: EXIT.usage },
    );

  const { site } = await resolveSite(ctx, session, flags);
  const label = event === "Purchase" ? "purchase" : "lead";
  const interrupted = () =>
    new CliError("INTERRUPTED", "Stopped waiting.", { exit: EXIT.interrupted });
  const started = ctx.now();
  const deadline = started + wait * 60_000;
  // Server-clock cutoff, learned from the first answer; until then, minutes back.
  let cutoff: number | null = null;
  // Server time = local time + skew, measured from each answer's checkedAt.
  let skew = 0;
  let last: unknown = null;
  let partialSeen = false;
  let lastError: CliError | null = null;
  let slot = 0;
  while (true) {
    if (ctx.signal.aborted) throw interrupted();
    const sinceMinutes =
      cutoff === null
        ? // No answer yet: keep reaching back to `since` minutes before the start.
          Math.min(1440, since + Math.ceil((ctx.now() - started) / 60_000))
        : Math.min(
            1440,
            Math.max(1, Math.ceil((ctx.now() + skew - cutoff) / 60_000)),
          );
    let retryAfterMs = 0;
    // The server stamps checkedAt when the request arrives, before reading
    // Stape, so skew is measured against when it was sent, not answered.
    const sentAt = ctx.now();
    try {
      const { data } = await callTool(
        session,
        ctx.config.origin,
        "check_event",
        { websiteId: site.websiteId, event, sinceMinutes },
        ctx.fetcher,
        { signal: ctx.signal },
      );
      if (ctx.signal.aborted) throw interrupted();
      last = data;
      lastError = null;
      const d = rec(data);
      const checkedAt = Date.parse(str(d.checkedAt) ?? "");
      if (Number.isFinite(checkedAt)) skew = checkedAt - sentAt;
      // The window is `since` minutes before the start, on the server's clock.
      // Never the answer's own `since`: a request widened after a failed first
      // poll reaches further back than the customer asked.
      if (cutoff === null) cutoff = started + skew - since * 60_000;
      const latest = rec(d.latest);
      const latestAt = Date.parse(str(latest.time) ?? "");
      // An event from before the window (a widened request reached it) doesn't count.
      const inWindow = !Number.isFinite(latestAt) || latestAt >= cutoff;
      if (d.found === true && inWindow)
        return {
          data,
          human: () =>
            [
              `Crisper received a ${label} on ${safeText(site.domain)}: ${safeText(d.count)}${d.partial ? "+" : ""} in the window.`,
              `Latest: ${safeText(latest.time)} (status ${safeText(latest.receivedStatus)}).`,
              "This proves Crisper received it, not that Meta or TikTok accepted it.",
            ].join("\n"),
        };
      if (d.partial === true) partialSeen = true;
    } catch (error) {
      // Only a retryable failure inside a wait is worth another try.
      if (!(error instanceof CliError) || !error.retryable || wait === 0)
        throw error;
      lastError = error;
      retryAfterMs = (error.retryAfterSeconds ?? 0) * 1000;
    }
    // Next slot on the once-a-minute grid. A slow request can't add an extra
    // poll: missed slots are skipped, and never sooner than the server asked.
    slot += 1;
    let nextAt = started + slot * POLL_MS;
    const earliest = ctx.now() + retryAfterMs;
    while (earliest - nextAt >= POLL_MS) {
      slot += 1;
      nextAt += POLL_MS;
    }
    nextAt = Math.max(nextAt, earliest);
    if (nextAt > deadline) break;
    ctx.writer.err(
      lastError
        ? `${lastError.message} Trying again shortly…`
        : "Not yet. Checking again in about a minute…",
    );
    await ctx.sleep(Math.max(0, nextAt - ctx.now()));
    if (ctx.signal.aborted) throw interrupted();
    // A slow request or sleep can still overrun the deadline: check real time.
    if (ctx.now() > deadline) break;
  }
  if (lastError) throw lastError;
  const windowText = `in the last ${since} minute${since === 1 ? "" : "s"} before this check`;
  if (partialSeen)
    throw withData(
      new CliError(
        "EVIDENCE_INCOMPLETE",
        `Couldn't tell whether a ${label} arrived on ${safeText(site.domain)}: Stape returned only part of its log.`,
        {
          exit: EXIT.unavailable,
          retryable: true,
          next: `Run \`crisper events list --type ${label}\` or check Logs in the dashboard.`,
        },
      ),
      last,
    );
  throw withData(
    new CliError(
      "NOT_OBSERVED",
      `No ${label} received on ${safeText(site.domain)} ${windowText}.`,
      {
        exit: EXIT.customerAction,
        retryable: true,
        next: "Stape logs can lag about a minute. Send a test event, then run this again with --wait 5.",
      },
    ),
    last,
  );
}

// ---- Integrations ---------------------------------------------------------

export async function integrationsList(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags,
) {
  const { site, d, data } = await siteCall(
    ctx,
    session,
    flags,
    "list_integrations",
  );
  return {
    data,
    human: () => {
      const items = Array.isArray(d.integrations)
        ? d.integrations.map(rec)
        : [];
      const more =
        d.truncated === true
          ? [
              "",
              "Crisper checked only the first 50 attachments; see the dashboard for the rest.",
            ]
          : [];
      if (!items.length)
        return [
          d.truncated === true
            ? `No integrations found among the first 50 on ${safeText(site.domain)}.`
            : `No integrations on ${safeText(site.domain)} yet. Connect one: crisper integrations connect --platform meta --pixel <id>`,
          ...more,
        ].join("\n");
      return [
        table([
          ["ID", "TYPE", "NAME"],
          ...items.map((i) => [
            str(i.integrationId) ?? "",
            str(i.type) ?? "",
            str(i.name) ?? "",
          ]),
        ]),
        ...more,
      ].join("\n");
    },
  };
}

/**
 * Connect Meta or TikTok. The access token is read from a hidden prompt, or
 * from standard input with --token-stdin; there is no flag for it.
 */
export async function integrationsConnect(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags & {
    platform: string;
    pixel: string;
    label?: string;
    tokenStdin: boolean;
    yes: boolean;
  },
) {
  const platform = flags.platform.toLowerCase();
  if (platform !== "meta" && platform !== "tiktok")
    throw new CliError(
      "INVALID_ARGUMENT",
      "Use --platform meta or --platform tiktok.",
      { exit: EXIT.usage },
    );
  const pixelId = flags.pixel.trim();
  const { site } = await resolveSite(ctx, session, flags);
  const changes = [
    `Connect ${platform === "meta" ? "Meta" : "TikTok"} pixel ${safeText(pixelId)} to ${safeText(site.domain)}${flags.label ? ` with label ${safeText(flags.label)}` : ""}. If your organization already saved this pixel, the new token replaces the old one for every site using it.`,
  ];
  ctx.writer.err(changes.join("\n"));
  // Approval precedes secret input, including piped stdin.
  await confirm(
    ctx.prompter,
    ctx.interactive && !ctx.mode.json && !flags.tokenStdin,
    flags.yes,
    "Connect it?",
    { changes, argv: ctx.argv ?? [] },
  );
  const tokenName =
    platform === "meta"
      ? "Conversions API access token"
      : "Events API access token";
  const accessToken = flags.tokenStdin
    ? await ctx.prompter.stdin()
    : await ctx.prompter.secret(`${tokenName} (hidden): `);
  if (accessToken.length < 20)
    throw new CliError(
      "INVALID_ARGUMENT",
      `That doesn't look like a ${tokenName}.`,
      { exit: EXIT.usage },
    );
  const { data } = await callTool(
    session,
    ctx.config.origin,
    "connect_integration",
    {
      websiteId: site.websiteId,
      platform,
      pixelId,
      accessToken,
      ...(flags.label ? { label: flags.label } : {}),
    },
    ctx.fetcher,
    { write: true, signal: ctx.signal },
  );
  const d = rec(data);
  return {
    data,
    human: () =>
      [
        `${platform === "meta" ? "Meta" : "TikTok"} pixel ${safeText(d.pixelId ?? pixelId)} ${d.status === "updated" ? "updated" : d.status === "already_connected" ? "was already connected" : "connected"} on ${safeText(site.domain)}.`,
        "This doesn't prove the platform accepts events. Send a test, then run `crisper events verify --type purchase`.",
      ].join("\n"),
  };
}

// ---- Billing --------------------------------------------------------------

export async function billingStatus(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags,
) {
  const { site, d, data } = await siteCall(
    ctx,
    session,
    flags,
    "get_billing_status",
  );
  const end =
    typeof d.currentPeriodEnd === "number"
      ? new Date(d.currentPeriodEnd * 1000).toISOString().slice(0, 10)
      : null;
  // Older servers send no displayStatus; fall back to the raw Stripe status.
  const statusLabel = humanStatus(d.displayStatus) ?? humanStatus(d.status);
  return {
    data,
    human: () =>
      [
        `${safeText(site.domain)}: ${safeText(statusLabel)}${d.plan ? ` (${safeText(d.plan)})` : ""}`,
        d.cancelAtPeriodEnd === true && end
          ? `Ends on ${end}.`
          : end
            ? `Renews on ${end}.`
            : "",
      ]
        .filter(Boolean)
        .join("\n"),
  };
}

/** The billing page link; this opens nothing and charges nothing. */
export async function billingLink(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags & { open: boolean },
) {
  const { site, d, data } = await siteCall(
    ctx,
    session,
    flags,
    "get_billing_link",
  );
  const url = str(d.url);
  const sameSite = (() => {
    try {
      return (
        url !== null &&
        new URL(url).origin === new URL(ctx.config.origin).origin
      );
    } catch {
      return false;
    }
  })();
  if (
    flags.open &&
    url &&
    ctx.interactive &&
    sameSite &&
    url.startsWith("https://")
  )
    await ctx.openBrowser(url).catch(() => {});
  return {
    data,
    human: () =>
      [
        `Open this to choose a plan and pay for ${safeText(site.domain)}:`,
        safeText(url ?? ""),
        "",
        "Then run `crisper billing status`.",
      ].join("\n"),
  };
}

/** Cancel at the end of the period (the dashboard's "Cancel subscription"): two server steps around a typed yes. */
export async function billingCancel(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags & { yes: boolean },
) {
  // The first call only asks for a confirmation; nothing changes yet.
  const first = await siteCall(ctx, session, flags, "cancel_billing");
  if (first.d.status === "already_scheduled")
    return {
      data: first.data,
      human: () =>
        `Billing for ${safeText(first.site.domain)} already ends on ${safeText(first.d.currentPeriodEnd ?? "the period end")}.`,
    };
  const confirmation = str(first.d.confirmation);
  if (first.d.status !== "confirmation_required" || !confirmation)
    throw withData(
      new CliError(
        "SERVER_ERROR",
        "Crisper didn't return a cancellation to confirm. Nothing was changed.",
        {
          exit: EXIT.failure,
          next: "Run `crisper billing status`, then try again.",
        },
      ),
      first.data,
    );
  const changes = [
    `Cancel billing for ${safeText(first.site.domain)}${first.d.plan ? ` (${safeText(first.d.plan)})` : ""}. Tracking continues until ${safeText(first.d.currentPeriodEnd ?? "the end of the period")}, then stops.`,
  ];
  ctx.writer.err(changes.join("\n"));
  await confirm(
    ctx.prompter,
    ctx.interactive && !ctx.mode.json,
    flags.yes,
    "Cancel billing?",
    {
      changes,
      argv: ctx.argv ?? [],
    },
  );
  const { data } = await callTool(
    session,
    ctx.config.origin,
    "cancel_billing",
    { websiteId: first.site.websiteId, confirmation },
    ctx.fetcher,
    { write: true, signal: ctx.signal },
  );
  const d = rec(data);
  if (d.status !== "cancel_requested" && d.status !== "already_scheduled")
    throw withData(
      new CliError(
        "WRITE_UNCONFIRMED",
        "Crisper didn't confirm the cancellation.",
        {
          exit: EXIT.unconfirmed,
          next: "Check with `crisper billing status` before trying again.",
        },
      ),
      data,
    );
  return {
    data,
    human: () =>
      `Billing for ${safeText(first.site.domain)} ends on ${safeText(d.currentPeriodEnd ?? "the period end")}. Tracking continues until then.`,
  };
}
