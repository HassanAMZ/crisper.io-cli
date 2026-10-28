import { type CliConfig } from "../config.js";
import { CliError, EXIT, authRequired } from "../errors.js";
import { type TokenSet } from "./device.js";
import { withLock } from "./lock.js";
import {
  type ConfigStore,
  type Profile,
  type SecretStore,
  secretName,
} from "./store.js";
import { refreshTokens, revokeToken } from "./tokens.js";

/** Refresh this long before expiry so a call never starts with a dying token. */
const REFRESH_SKEW_MS = 60_000;

export type Session = {
  profile: Profile;
  /** Current access token: refreshed if needed. Never log or print it. */
  accessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  /** Revoke remotely (best effort) and clear locally. Returns whether revocation was confirmed. */
  signOut(): Promise<boolean>;
  updateProfile(patch: Partial<Profile>): Promise<void>;
};

export type SessionDeps = {
  config: CliConfig;
  secrets: SecretStore;
  configs: ConfigStore;
  fetcher?: typeof fetch;
  now?: () => number;
};

const expired = () =>
  new CliError("AUTH_EXPIRED", "Your sign-in has expired or was revoked.", {
    exit: EXIT.auth,
    next: "Run `crisper login`.",
  });

/** The issuer and endpoints come back from a plain file: trust them only if they are still https. */
function httpsOnly(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

const names = (config: CliConfig, clientId: string) => ({
  access: secretName(config.origin, clientId, "access"),
  refresh: secretName(config.origin, clientId, "refresh"),
});

export async function saveSession(
  deps: SessionDeps,
  args: {
    issuer: string;
    clientId: string;
    resource: string;
    tokenEndpoint: string;
    revocationEndpoint: string | null;
    tokens: TokenSet;
  },
): Promise<Profile> {
  const { config, secrets, configs } = deps;
  const n = names(config, args.clientId);
  return withLock(configs.lockFile, async () => {
    const file = await configs.read();
    const profile: Profile = {
      origin: config.origin,
      issuer: args.issuer,
      clientId: args.clientId,
      resource: args.resource,
      tokenEndpoint: args.tokenEndpoint,
      revocationEndpoint: args.revocationEndpoint,
      expiresAt: args.tokens.expiresAt,
      scope: args.tokens.scope,
      subject: null,
      email: null,
      // The server gives no account identity yet, so a new sign-in never
      // inherits the previous one's choice (it might be someone else).
      defaultOrgId: null,
      signedInAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    };
    await secrets.set(n.access, args.tokens.accessToken);
    if (args.tokens.refreshToken)
      await secrets.set(n.refresh, args.tokens.refreshToken);
    else await secrets.delete(n.refresh);
    file.profiles[config.origin] = profile;
    await configs.write(file);
    return profile;
  });
}

/**
 * Remove both secrets and the profile. Every step is attempted; if the
 * credential store refused a deletion, that is reported after the rest is
 * cleaned, never hidden behind "signed out".
 */
export async function clearSession(deps: SessionDeps, clientId?: string) {
  const { config, secrets, configs } = deps;
  const file = await configs.read();
  const id =
    clientId ?? file.profiles[config.origin]?.clientId ?? config.clientId;
  let failure: unknown = null;
  if (id) {
    const n = names(config, id);
    for (const name of [n.access, n.refresh]) {
      try {
        await secrets.delete(name);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  delete file.profiles[config.origin];
  await configs.write(file);
  if (failure) throw failure;
}

/** True when a profile exists for this origin, without loading tokens. */
export async function hasSession(deps: SessionDeps) {
  const file = await deps.configs.read();
  return Boolean(file.profiles[deps.config.origin]);
}

/** Load the signed-in session for this origin, or throw AUTH_REQUIRED. */
export async function loadSession(deps: SessionDeps): Promise<Session> {
  const { config, secrets, configs, fetcher = fetch, now = Date.now } = deps;
  const file = await configs.read();
  const profile = file.profiles[config.origin];
  if (!profile) throw authRequired();
  if (config.clientId && profile.clientId !== config.clientId)
    throw new CliError(
      "AUTH_REQUIRED",
      "Your sign-in is for a different Crisper app.",
      { exit: EXIT.auth, next: "Run `crisper login` again." },
    );
  const issuer = httpsOnly(profile.issuer);
  const tokenEndpoint = httpsOnly(profile.tokenEndpoint);
  const revocationEndpoint = httpsOnly(profile.revocationEndpoint);
  if (!issuer || !tokenEndpoint) {
    await clearSession(deps, profile.clientId);
    throw authRequired();
  }
  const n = names(config, profile.clientId);

  const persist = async () => {
    const current = await configs.read();
    current.profiles[config.origin] = profile;
    await configs.write(current);
  };

  const refreshWith = (refreshToken: string) =>
    refreshTokens(
      {
        tokenEndpoint,
        clientId: profile.clientId,
        refreshToken,
        resource: profile.resource,
      },
      fetcher,
      now,
    );

  // One refresh at a time per process; concurrent callers share it. Across
  // processes the lock file serializes, and the refresh token is re-read
  // under it so a rotation by another process is used, not fought.
  let refreshing: Promise<string> | null = null;

  // `rejected` is the token the server just refused (a 401): it is never
  // handed back, even if the profile still calls it fresh.
  const refresh = (rejected: string | null): Promise<string> =>
    withLock(configs.lockFile, async () => {
      const latest = await configs.read();
      const current = latest.profiles[config.origin];
      if (!current) throw authRequired();
      if (current.expiresAt - REFRESH_SKEW_MS > now()) {
        // Another process may already have refreshed while we waited.
        const fresh = await secrets.get(n.access);
        if (fresh && fresh !== rejected) {
          Object.assign(profile, current);
          return fresh;
        }
      }
      const refreshToken = await secrets.get(n.refresh);
      if (!refreshToken) {
        await clearSession(deps, profile.clientId);
        throw expired();
      }
      let tokens: TokenSet;
      try {
        tokens = await refreshWith(refreshToken);
      } catch (error) {
        if (error instanceof CliError && error.code === "AUTH_EXPIRED")
          await clearSession(deps, profile.clientId);
        throw error;
      }
      // Commit the new generation: refresh token first, so a crash between
      // the two writes leaves a pair the next refresh can still use.
      if (tokens.refreshToken)
        await secrets.set(n.refresh, tokens.refreshToken);
      await secrets.set(n.access, tokens.accessToken);
      profile.expiresAt = tokens.expiresAt;
      profile.scope = tokens.scope ?? profile.scope;
      await persist();
      return tokens.accessToken;
    });

  const session: Session = {
    profile,
    async accessToken({ forceRefresh = false } = {}) {
      const unknownLifetime = profile.expiresAt === 0;
      const stale =
        !unknownLifetime && profile.expiresAt - REFRESH_SKEW_MS <= now();
      const token = await secrets.get(n.access);
      if (!forceRefresh && !stale && token) return token;
      refreshing ??= refresh(forceRefresh ? token : null).finally(() => {
        refreshing = null;
      });
      return refreshing;
    },
    async signOut() {
      return withLock(configs.lockFile, async () => {
        const access = await secrets.get(n.access);
        const refreshToken = await secrets.get(n.refresh);
        // No advertised revocation endpoint means we can't confirm anything.
        let confirmed = revocationEndpoint !== null;
        if (revocationEndpoint) {
          for (const [token, hint] of [
            [refreshToken, "refresh_token"],
            [access, "access_token"],
          ] as const) {
            if (!token) continue;
            const ok = await revokeToken(
              {
                revocationEndpoint,
                clientId: profile.clientId,
                token,
                tokenTypeHint: hint,
              },
              fetcher,
            );
            confirmed = confirmed && ok;
          }
        }
        await clearSession(deps, profile.clientId);
        return confirmed;
      });
    },
    async updateProfile(patch) {
      Object.assign(profile, patch);
      await persist();
    },
  };
  return session;
}
