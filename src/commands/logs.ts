import { randomUUID } from "node:crypto";
import { link, open, rename, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { type Session } from "../auth/session.js";
import { CliError, EXIT } from "../errors.js";
import { callTool } from "../mcp/client.js";
import { safeText, shellArg, table } from "../output.js";
import { record } from "../record.js";
import { type CommandContext } from "./context.js";
import { EVENT_TYPES } from "./setup.js";
import { type TargetFlags, resolveSite } from "./target.js";

const str = (v: unknown) => (typeof v === "string" ? v : null);

export type WindowFlags = TargetFlags & { since: string; until?: string };
export type FilterFlags = { event?: string; client?: string; status?: string };

/** Time bounds go to the server as typed (ISO, a date, or 90m / 24h / 7d); it parses them. */
function windowArgs(flags: WindowFlags) {
  for (const [name, value] of [
    ["--since", flags.since],
    ["--until", flags.until],
  ] as const)
    if (
      value !== undefined &&
      (!value.trim() ||
        value.length > 40 ||
        /[\s\u0000-\u001f]/.test(value.trim()))
    )
      throw new CliError("INVALID_ARGUMENT", `Invalid ${name}.`, {
        exit: EXIT.usage,
        next: `Use ${name} as an ISO time (2026-11-04T10:00:00Z), a date (2026-11-04) or an age (90m, 24h, 7d).`,
      });
  return {
    since: flags.since.trim(),
    ...(flags.until ? { until: flags.until.trim() } : {}),
  };
}

function filterArgs(flags: FilterFlags) {
  return {
    ...(flags.event ? { event: flags.event } : {}),
    ...(flags.client ? { client: flags.client } : {}),
    ...(flags.status ? { status: flags.status } : {}),
  };
}

function limitOf(raw: string | undefined, fallback: number) {
  const limit = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new CliError("INVALID_ARGUMENT", "--limit must be 1 to 100.", {
      exit: EXIT.usage,
    });
  return limit;
}

/** The flags that reproduce this query, for a suggested next command. */
function queryArgs(
  orgId: string,
  domain: string,
  flags: WindowFlags & FilterFlags,
) {
  return [
    `--org ${shellArg(orgId)} --site ${shellArg(domain)}`,
    `--since ${shellArg(flags.since)}`,
    ...(flags.until ? [`--until ${shellArg(flags.until)}`] : []),
    ...(flags.event ? [`--event ${shellArg(flags.event)}`] : []),
    ...(flags.client ? [`--client ${shellArg(flags.client)}`] : []),
    ...(flags.status ? [`--status ${shellArg(flags.status)}`] : []),
  ].join(" ");
}

const money = (e: Record<string, unknown>) =>
  typeof e.value === "number"
    ? `${e.value}${e.currency ? ` ${safeText(e.currency)}` : ""}`
    : "";

/** `crisper logs list`: one page of the site's requests, newest first (list_events). */
export async function logsList(
  ctx: CommandContext,
  session: Session,
  flags: WindowFlags & FilterFlags & { limit?: string; cursor?: string },
) {
  const limit = limitOf(flags.limit, 50);
  const { orgId, site } = await resolveSite(ctx, session, flags);
  const { data } = await callTool(
    session,
    ctx.config.origin,
    "list_events",
    {
      websiteId: site.websiteId,
      ...windowArgs(flags),
      ...filterArgs(flags),
      limit,
      ...(flags.cursor ? { cursor: flags.cursor } : {}),
    },
    ctx.fetcher,
    { signal: ctx.signal },
  );
  const d = record(data);
  const events = Array.isArray(d.events) ? d.events.map(record) : [];
  const next = str(d.nextCursor);
  return {
    data,
    context: { orgId, siteId: site.websiteId },
    human: () => {
      const lines = [
        events.length
          ? table([
              [
                "TIME",
                "EVENT",
                "CLIENT",
                "STATUS",
                "SOURCE",
                "VALUE",
                "VISITOR",
                "EMAIL (MASKED)",
                "PHONE (MASKED)",
                "IP (MASKED)",
              ],
              ...events.map((e) => [
                str(e.time) ?? "",
                str(e.event) ?? "",
                str(e.client) ?? "",
                str(e.status) ?? "",
                [str(e.source), str(e.medium)].filter(Boolean).join(" / "),
                money(e),
                str(e.visitor) ?? "",
                str(record(e.contact).email) ?? "",
                str(record(e.contact).phone) ?? "",
                str(record(e.contact).ip) ?? "",
              ]),
            ])
          : `No requests on ${safeText(site.domain)} in this window.`,
      ];
      if (d.partial === true)
        lines.push(
          "",
          "Stape returned only part of a busy stretch here, so some rows are missing.",
        );
      if (next)
        lines.push(
          "",
          "Older rows:",
          `  crisper logs list ${queryArgs(orgId, site.domain, flags)} --cursor ${shellArg(next)}`,
        );
      return lines.join("\n");
    },
  };
}

const CSV_COLUMNS = [
  "time",
  "event",
  "client",
  "status",
  "path",
  "source",
  "medium",
  "value",
  "currency",
  "visitor",
  "logId",
  "emailMasked",
  "phoneMasked",
  "ipMasked",
] as const;

/** Quote every cell; a cell a spreadsheet would run as a formula starts with '. */
export function csvCell(value: unknown): string {
  // A number (a refund's -12.5) is data, not a formula: no guard.
  if (typeof value === "number" && Number.isFinite(value))
    return `"${String(value)}"`;
  const text = value == null ? "" : String(value);
  const safe = /^([\t\r]|[\s\u0000-\u001f]*[=+\-@])/u.test(text)
    ? `'${text}`
    : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

const MAX_RATE_WAITS = 5;

/**
 * `crisper logs export`: every page of list_events for the window, written to
 * a file as NDJSON (one event per line) or CSV. Waits out rate limits; stops
 * after --max-pages and says how to continue.
 */
export async function logsExport(
  ctx: CommandContext,
  session: Session,
  flags: WindowFlags &
    FilterFlags & {
      output: string;
      format: string;
      maxPages?: string;
      cursor?: string;
      force: boolean;
    },
) {
  const format = flags.format.toLowerCase();
  if (format !== "ndjson" && format !== "csv")
    throw new CliError("INVALID_ARGUMENT", "Use --format ndjson or csv.", {
      exit: EXIT.usage,
    });
  const maxPages = flags.maxPages === undefined ? 100 : Number(flags.maxPages);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000)
    throw new CliError("INVALID_ARGUMENT", "--max-pages must be 1 to 1000.", {
      exit: EXIT.usage,
    });
  const file = resolve(flags.output);
  const exists = await stat(file).then(
    () => true,
    () => false,
  );
  if (exists && !flags.force)
    throw new CliError(
      "INVALID_ARGUMENT",
      `${safeText(file)} already exists.`,
      {
        exit: EXIT.usage,
        next: "Choose another --output, or add --force to replace it.",
      },
    );
  const base = { ...windowArgs(flags), ...filterArgs(flags) };
  const { orgId, site } = await resolveSite(ctx, session, flags);
  const rows: Record<string, unknown>[] = [];
  // --cursor resumes an export that stopped at --max-pages.
  let cursor: string | null = flags.cursor ?? null;
  let pages = 0;
  let partial = false;
  let rateWaits = 0;
  // An error after some pages ends the export with what it has, so the rows
  // already read are kept and the export can resume from the last cursor.
  let failure: CliError | null = null;
  while (!ctx.signal.aborted) {
    const sent = cursor;
    try {
      const { data } = await callTool(
        session,
        ctx.config.origin,
        "list_events",
        {
          websiteId: site.websiteId,
          ...base,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
        ctx.fetcher,
        { signal: ctx.signal },
      );
      const d = record(data);
      const events = Array.isArray(d.events) ? d.events.map(record) : [];
      rows.push(...events);
      partial ||= d.partial === true;
      const next = str(d.nextCursor);
      pages += 1;
      if (events.length === 0 && next !== null && next === sent) {
        // No rows and the same cursor: asking again would go nowhere.
        failure = new CliError(
          "SERVER_ERROR",
          "Crisper returned the same page again without rows.",
          {
            exit: EXIT.failure,
            retryable: true,
            next: "Try again in a few minutes, or use a shorter window or a filter.",
          },
        );
        break;
      }
      cursor = next;
      // Count consecutive rate limits only: a long export may meet several.
      rateWaits = 0;
      if (!cursor || pages >= maxPages) break;
      ctx.writer.err(`${rows.length} rows so far…`);
    } catch (error) {
      if (
        error instanceof CliError &&
        error.code === "RATE_LIMITED" &&
        rateWaits < MAX_RATE_WAITS
      ) {
        rateWaits += 1;
        const wait = error.retryAfterSeconds ?? 60;
        ctx.writer.err(`Rate limited; waiting ${wait} seconds…`);
        await ctx.sleep(wait * 1000);
        continue;
      }
      // Rows already read are kept on any stop, Ctrl-C included.
      if (rows.length > 0 && error instanceof CliError) {
        failure = error;
        break;
      }
      throw error;
    }
  }
  if (ctx.signal.aborted && !failure) {
    if (rows.length === 0)
      throw new CliError("INTERRUPTED", "Stopped; no file was written.", {
        exit: EXIT.interrupted,
      });
    failure = new CliError("INTERRUPTED", "Stopped.", {
      exit: EXIT.interrupted,
    });
  }
  if (failure && rows.length === 0) throw failure;
  const body =
    format === "ndjson"
      ? rows.map((r) => JSON.stringify(r)).join("\n") +
        (rows.length ? "\n" : "")
      : [
          CSV_COLUMNS.join(","),
          ...rows.map((r) =>
            CSV_COLUMNS.map((c) =>
              csvCell(
                c.endsWith("Masked") ? record(r.contact)[c.slice(0, -6)] : r[c],
              ),
            ).join(","),
          ),
        ].join("\n") + "\n";
  // Written whole, then put in place, so a reader never sees half a file.
  // Without --force a file that appeared meanwhile is kept (link fails on it).
  // The temporary name is random and created exclusively ("wx"), so it never
  // follows or reuses anything already there, such as another user's symlink.
  let temp = "";
  for (let attempt = 1; ; attempt++) {
    const name = `${file}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(name, "wx", 0o600);
    } catch (error) {
      // Something is already there: not ours, never touched. Try a new name.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 3)
        throw error;
      continue;
    }
    // Ours from here: a failed write (a full disk) removes it.
    try {
      await handle.writeFile(body);
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(name).catch(() => {});
      throw error;
    }
    await handle.close();
    temp = name;
    break;
  }
  try {
    if (flags.force) await rename(temp, file);
    else await link(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliError(
        "INVALID_ARGUMENT",
        `${safeText(file)} appeared while exporting; it was kept.`,
        {
          exit: EXIT.usage,
          next: "Choose another --output, or add --force to replace it.",
        },
      );
    throw error;
  } finally {
    await unlink(temp).catch(() => {});
  }
  const complete = cursor === null && failure === null;
  const resume = `crisper logs export ${queryArgs(orgId, site.domain, flags)} --format ${format} --output <next file> --cursor ${shellArg(cursor)}`;
  const summary = {
    file,
    format,
    rows: rows.length,
    pages,
    partial,
    complete,
    nextCursor: cursor,
  };
  if (failure) {
    const error = new CliError(
      failure.code,
      `${failure.message} The ${rows.length} rows read before it are in ${safeText(file)}.`,
      {
        exit: failure.exit,
        retryable: failure.retryable,
        ...(failure.retryAfterSeconds !== null
          ? { retryAfterSeconds: failure.retryAfterSeconds }
          : {}),
        ...(cursor
          ? { next: `Resume into another file: ${resume}` }
          : failure.next
            ? { next: failure.next }
            : {}),
      },
    );
    error.data = summary;
    throw error;
  }
  return {
    data: summary,
    context: { orgId, siteId: site.websiteId },
    human: () =>
      [
        `Wrote ${rows.length} rows from ${safeText(site.domain)} to ${safeText(file)}.`,
        ...(partial
          ? [
              "Stape returned only part of some busy stretches, so some rows are missing.",
            ]
          : []),
        ...(complete
          ? []
          : [
              `Stopped after ${pages} pages; the file holds part of the window. Continue into another file with:`,
              `  ${resume}`,
            ]),
      ].join("\n"),
  };
}

const GROUPS = ["day", "event", "source", "medium", "client"] as const;

/** `crisper logs stats`: purchases and leads, counted and summed per group (get_event_stats). */
export async function logsStats(
  ctx: CommandContext,
  session: Session,
  flags: WindowFlags & { by?: string; type?: string },
) {
  const groupBy = (flags.by ?? "day")
    .split(",")
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
  if (
    groupBy.length < 1 ||
    groupBy.length > 2 ||
    groupBy.some((g) => !(GROUPS as readonly string[]).includes(g))
  )
    throw new CliError(
      "INVALID_ARGUMENT",
      `Use --by with one or two of: ${GROUPS.join(", ")}.`,
      { exit: EXIT.usage, next: "For example: --by day,source" },
    );
  let event: string | undefined;
  if (flags.type !== undefined) {
    event = EVENT_TYPES[flags.type.toLowerCase()];
    if (!event)
      throw new CliError("INVALID_ARGUMENT", "Use --type purchase or lead.", {
        exit: EXIT.usage,
      });
  }
  const { orgId, site } = await resolveSite(ctx, session, flags);
  const { data } = await callTool(
    session,
    ctx.config.origin,
    "get_event_stats",
    {
      websiteId: site.websiteId,
      ...windowArgs(flags),
      groupBy,
      ...(event ? { event } : {}),
    },
    ctx.fetcher,
    { signal: ctx.signal },
  );
  const d = record(data);
  const rows = Array.isArray(d.rows) ? d.rows.map(record) : [];
  const coverage = record(d.coverage);
  const value = (v: unknown) =>
    Object.entries(record(v))
      .map(([currency, n]) => `${safeText(n)} ${safeText(currency)}`)
      .join(", ");
  return {
    data,
    context: { orgId, siteId: site.websiteId },
    human: () =>
      [
        rows.length
          ? table([
              [...groupBy.map((g) => g.toUpperCase()), "COUNT", "VALUE"],
              ...rows.map((r) => [
                ...groupBy.map((g) => str(r[g]) ?? "(none)"),
                String(r.count ?? ""),
                value(r.value),
              ]),
            ])
          : `No purchases or leads on ${safeText(site.domain)} in this window.`,
        "",
        `Total: ${safeText(record(d.totals).count)}${value(record(d.totals).value) ? ` (${value(record(d.totals).value)})` : ""}. Days in ${safeText(d.timezone)}.`,
        coverage.complete === true
          ? `Complete to ${safeText(coverage.to)}.`
          : "Counts are a minimum: the window starts before Crisper's saved copy, the 15-minute poll hasn't run since it began, or it was too large to read whole.",
        "Source is what the visit reported, not attribution.",
      ].join("\n"),
  };
}

/** `crisper logs drop`: why did the site's leads drop (get_lead_drop). */
export async function logsDrop(
  ctx: CommandContext,
  session: Session,
  flags: TargetFlags,
) {
  const { orgId, site } = await resolveSite(ctx, session, flags);
  const { data } = await callTool(
    session,
    ctx.config.origin,
    "get_lead_drop",
    { websiteId: site.websiteId },
    ctx.fetcher,
    { signal: ctx.signal },
  );
  const d = record(data);
  const summary = Array.isArray(d.summary)
    ? d.summary.filter((line): line is string => typeof line === "string")
    : [];
  const days = Array.isArray(d.days) ? d.days.map(record) : [];
  return {
    data,
    context: { orgId, siteId: site.websiteId },
    human: () =>
      [
        ...summary.map(safeText),
        "",
        table([
          ["DAY", "LEADS"],
          ...days.map((day) => [
            str(day.date) ?? "",
            typeof day.leads === "number" ? String(day.leads) : "unknown",
          ]),
        ]),
        "",
        `Leads per finished day in ${safeText(d.timezone)}, as Overview saved them. Delivery is Crisper's own check, not Meta's acceptance; sources are what visits reported, not attribution.`,
      ].join("\n"),
  };
}
