import { CliError, EXIT } from "./errors.js";

export const DEFAULT_ORIGIN = "https://crisper.io";
export const SERVICE_NAME = "crisperio";

/**
 * First-party public Clerk OAuth clients, by Crisper origin. There is no secret:
 * a public client identifies itself by ID alone. Other origins (local or
 * staging servers) set CRISPER_OAUTH_CLIENT_ID.
 */
const CLIENT_IDS: Record<string, string> = {
  "https://crisper.io": "I4beUQQdtiLgmMUb",
};

export type CliConfig = {
  origin: string;
  clientId: string | null;
  scope: string;
};

/** Only https origins, or http on this machine, may be an MCP origin. */
export function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("INVALID_ARGUMENT", `Not a URL: ${raw}`, {
      exit: EXIT.usage,
      next: "Set CRISPER_ORIGIN to an https:// URL or unset it.",
    });
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new CliError("INVALID_ARGUMENT", `Refusing insecure origin ${raw}`, {
      exit: EXIT.usage,
      next: "CRISPER_ORIGIN must use https:// unless it is localhost.",
    });
  return url.origin;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const origin = normalizeOrigin(env.CRISPER_ORIGIN ?? DEFAULT_ORIGIN);
  const clientId = env.CRISPER_OAUTH_CLIENT_ID ?? CLIENT_IDS[origin] ?? null;
  return { origin, clientId, scope: "profile email offline_access" };
}

export function requireClientId(config: CliConfig): string {
  if (!config.clientId)
    throw new CliError(
      "CAPABILITY_UNAVAILABLE",
      "CLI sign-in isn't enabled for Crisper yet.",
      {
        exit: EXIT.unavailable,
        next: "Use the Crisper MCP in your AI client for now: https://crisper.io/mcp",
      },
    );
  return config.clientId;
}
