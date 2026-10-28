import { CliError } from "./errors.js";

export const SCHEMA_VERSION = 1;

export type Context = {
  origin: string;
  orgId?: string | null;
  siteId?: string | null;
};

export type Envelope = {
  schemaVersion: number;
  command: string;
  ok: boolean;
  context: Context;
  data: unknown;
  error: ReturnType<CliError["toJSON"]> | null;
  meta: { observedAt: string; requestId: string | null } & Record<
    string,
    unknown
  >;
};

export type OutputMode = {
  json: boolean;
  color: boolean;
  /** `--timing`: print how long each request took, on stderr. */
  timing?: boolean;
};

export function envelope(
  command: string,
  context: Context,
  result:
    | { ok: true; data: unknown; meta?: Record<string, unknown> }
    | { ok: false; error: CliError; meta?: Record<string, unknown> },
  now: () => Date = () => new Date(),
): Envelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    ok: result.ok,
    context,
    data: result.ok ? result.data : (result.error.data ?? null),
    error: result.ok ? null : result.error.toJSON(),
    meta: {
      observedAt: now().toISOString(),
      requestId: null,
      ...(result.meta ?? {}),
    },
  };
}

// C0 controls (including newline and tab, so one field can't forge a line),
// DEL and the C1 range (0x80–0x9f), which some terminals also interpret.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Terminal output treats every string from the server as data: control
 * characters are escaped so a site name can't repaint the terminal or add a
 * table row. Use it on every server-provided field, including IDs.
 */
export function safeText(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : value === null || value === undefined
        ? ""
        : String(value);
  return text.replace(CONTROLS, (c) => {
    const hex = c.charCodeAt(0).toString(16).padStart(2, "0");
    return `\\x${hex}`;
  });
}

/** A value for a command the user may copy into a shell: plain words as is, anything else single-quoted. */
export function shellArg(value: unknown): string {
  const text = safeText(value);
  return /^[A-Za-z0-9._:@/+-]+$/.test(text)
    ? text
    : `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Install scripts are printed as-is so they can be copied, keeping newlines
 * and tabs; every other control character (ESC, OSC, BEL, C1) is removed so a
 * script can't drive the terminal or its clipboard.
 */
export function safeScript(script: string): string {
  return (
    script
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
      // A lone carriage return could make one line print over another.
      .replace(/\r(?!\n)/g, "")
  );
}

/** JSON.stringify leaves C1 controls literal; escape them so stdout stays inert. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const cells = rows.map((r) => r.map(safeText));
  const widths = cells[0]!.map((_, i) =>
    Math.max(...cells.map((r) => (r[i] ?? "").length)),
  );
  return cells
    .map((r) =>
      r
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export type Writer = { out: (s: string) => void; err: (s: string) => void };

export const stdio: Writer = {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
};

/** JSON mode writes exactly one object to stdout; everything else goes to stderr. */
export function emit(
  mode: OutputMode,
  env: Envelope,
  human: (env: Envelope) => string,
  writer: Writer = stdio,
) {
  if (mode.json) {
    writer.out(safeJson(env));
    return;
  }
  if (env.ok) {
    writer.out(human(env));
    return;
  }
  const e = env.error!;
  writer.err(`${safeText(e.message)}${e.next ? `\n${safeText(e.next)}` : ""}`);
  if (e.code === "CONFIRMATION_REQUIRED") {
    const proposal = env.data as { confirmCommand?: unknown } | null;
    if (typeof proposal?.confirmCommand === "string")
      writer.err(`After approval: ${safeText(proposal.confirmCommand)}`);
  }
}
