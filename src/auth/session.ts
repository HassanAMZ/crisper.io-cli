import { type CliConfig } from "../config.js";
import { CliError, EXIT, authRequired } from "../errors.js";
import { type TokenSet } from "./device.js";
import { withLock } from "./lock.js";
import {
  type ConfigStore,
  type Profile,
  type SecretStore,
  newSlot,
  secretName,
  validClientId,
  validSlot,
} from "./store.js";
import { refreshTokens, revokeToken } from "./tokens.js";

/** Refresh this long before expiry so a call never starts with a dying token. */
const REFRESH_SKEW_MS = 60_000;

export type Session = {
  profile: Profile;
  /** Current access token: refreshed if needed. Never log or print it. */
  accessToken(options?: { forceRefresh?: boolean }): Promise<string>;
  /**
   * Revoke remotely (best effort) and clear locally. `hadToken` is false when
   * no token was left to revoke; `revoked` is true only when every token
   * found was confirmed revoked.
   */
  signOut(): Promise<{ revoked: boolean; hadToken: boolean }>;
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

/** Which sign-in to clear: its client and this folder's slot. */
type SessionKey = Pick<Profile, "clientId" | "slot">;

const names = (config: CliConfig, clientId: string, slot: string) => ({
  access: secretName(config.origin, clientId, "access", slot),
  refresh: secretName(config.origin, clientId, "refresh", slot),
});

/**
 * The entries a profile owns. A valid slot names its own entries; no slot is
 * a profile saved before 0.0.14, whose shared entries are cleared; any other
 * value came from an edited file and names nothing, so nothing is deleted.
 */
function entriesOf(config: CliConfig, key: SessionKey): string[] {
  if (!validClientId(key.clientId)) return [];
  if (key.slot === undefined)
    return (["access", "refresh"] as const).map((kind) =>
      secretName(config.origin, key.clientId, kind),
    );
  if (!validSlot(key.slot)) return [];
  const n = names(config, key.clientId, key.slot);
  return [n.access, n.refresh];
}

/** Whether two profiles are the same sign-in; values from the file may be any JSON. */
const sameSignIn = (a: SessionKey, b: SessionKey) =>
  JSON.stringify([a.clientId, a.slot ?? null]) ===
  JSON.stringify([b.clientId, b.slot ?? null]);

const signInAgain = () =>
  new CliError(
    "AUTH_REQUIRED",
    "Your earlier sign-in was removed: each config folder now keeps its own sign-in.",
    { exit: EXIT.auth, next: "Run `crisper login`." },
  );

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
  const slot = newSlot();
  const n = names(config, args.clientId, slot);
  return withLock(configs.lockFile, async () => {
    const file = await configs.read();
    const prior = file.profiles[config.origin];
    const profile: Profile = {
      origin: config.origin,
      issuer: args.issuer,
      clientId: args.clientId,
      resource: args.resource,
      tokenEndpoint: args.tokenEndpoint,
      revocationEndpoint: args.revocationEndpoint,
      expiresAt: args.tokens.expiresAt,
      scope: args.tokens.scope,
      slot,
      subject: null,
      email: null,
      // The server gives no account identity yet, so a new sign-in never
      // inherits the previous one's choice (it might be someone else).
      defaultOrgId: null,
      signedInAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    };
    try {
      await secrets.set(n.access, args.tokens.accessToken);
      if (args.tokens.refreshToken)
        await secrets.set(n.refresh, args.tokens.refreshToken);
      else await secrets.delete(n.refresh);
      file.profiles[config.origin] = profile;
      await configs.write(file);
    } catch (error) {
      // No profile names this slot, so nothing could ever clear it later.
      for (const name of [n.access, n.refresh])
        await secrets.delete(name).catch(() => {});
      throw error;
    }
    // A previous sign-in still here (its sign-out failed, or another
    // process signed in meanwhile) is revoked and leaves no tokens.
    if (prior) {
      await revokeHeld(deps, prior).catch(() => {});
      for (const name of entriesOf(config, prior))
        await secrets.delete(name).catch(() => {});
    }
    return profile;
  });
}

/**
 * Remove one sign-in's secrets and, if this folder still holds that sign-in,
 * its profile. With no key, the folder's current sign-in. A process holding
 * an older sign-in never clears a newer one made in the same folder. Every
 * step is attempted; if the credential store refused a deletion, that is
 * reported after the rest is cleaned, never hidden behind "signed out".
 * Takes the lock; code already holding it calls clearHeld.
 */
export const clearSession = (deps: SessionDeps, key?: SessionKey) =>
  withLock(deps.configs.lockFile, () => clearHeld(deps, key));

async function clearHeld(deps: SessionDeps, key?: SessionKey) {
  const { config, secrets, configs } = deps;
  const file = await configs.read();
  const current = file.profiles[config.origin];
  const target = key ?? current;
  if (!target) return;
  let failure: unknown = null;
  for (const name of entriesOf(config, target)) {
    try {
      await secrets.delete(name);
    } catch (error) {
      failure ??= error;
    }
  }
  if (current && sameSignIn(current, target)) {
    delete file.profiles[config.origin];
    await configs.write(file);
  }
  if (failure) throw failure;
}

/**
 * Revoke (best effort) whatever tokens a profile's own entries still hold.
 * The caller holds the lock. Only entriesOf's validated names are read.
 */
async function revokeHeld(deps: SessionDeps, profile: Profile) {
  const endpoint = httpsOnly(profile.revocationEndpoint);
  const [access, refresh] = entriesOf(deps.config, profile);
  if (!endpoint || !access || !refresh) return;
  for (const [name, hint] of [
    [refresh, "refresh_token"],
    [access, "access_token"],
  ] as const) {
    const token = await deps.secrets.get(name).catch(() => null);
    if (token)
      await revokeToken(
        {
          revocationEndpoint: endpoint,
          clientId: profile.clientId,
          token,
          tokenTypeHint: hint,
        },
        deps.fetcher ?? fetch,
      );
  }
}

/**
 * A profile saved before 0.0.14 points at one entry every config folder on
 * this computer shared, so it can't say whose sign-in it holds. It is revoked
 * (best effort), removed, and the person is asked to sign in again.
 */
async function retireShared(deps: SessionDeps, profile: Profile) {
  await withLock(deps.configs.lockFile, async () => {
    await revokeHeld(deps, profile);
    await clearHeld(deps, profile);
  });
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
  if (!validClientId(profile.clientId)) {
    await clearSession(deps, profile);
    throw authRequired();
  }
  if (config.clientId && profile.clientId !== config.clientId)
    throw new CliError(
      "AUTH_REQUIRED",
      "Your sign-in is for a different Crisper app.",
      { exit: EXIT.auth, next: "Run `crisper login` again." },
    );
  const issuer = httpsOnly(profile.issuer);
  const tokenEndpoint = httpsOnly(profile.tokenEndpoint);
  const revocationEndpoint = httpsOnly(profile.revocationEndpoint);
  if (profile.slot === undefined) {
    await retireShared(deps, profile);
    throw signInAgain();
  }
  if (!validSlot(profile.slot) || !issuer || !tokenEndpoint) {
    await clearSession(deps, profile);
    throw authRequired();
  }
  const slot = profile.slot;
  const n = names(config, profile.clientId, slot);

  // Saved only while this folder still holds this sign-in: a newer one made
  // here meanwhile is never overwritten by an older process. The caller
  // holds the lock, so the check and the write are one step.
  const persistHeld = async () => {
    const current = await configs.read();
    if (current.profiles[config.origin]?.slot !== slot) return;
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
      // Signed out, or signed in again in this folder by another process.
      if (!current || current.slot !== slot) throw authRequired();
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
        await clearHeld(deps, profile);
        throw expired();
      }
      let tokens: TokenSet;
      try {
        tokens = await refreshWith(refreshToken);
      } catch (error) {
        if (error instanceof CliError && error.code === "AUTH_EXPIRED")
          await clearHeld(deps, profile);
        throw error;
      }
      // Commit the new generation: refresh token first, so a crash between
      // the two writes leaves a pair the next refresh can still use.
      if (tokens.refreshToken)
        await secrets.set(n.refresh, tokens.refreshToken);
      await secrets.set(n.access, tokens.accessToken);
      profile.expiresAt = tokens.expiresAt;
      profile.scope = tokens.scope ?? profile.scope;
      await persistHeld();
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
        const hadToken = Boolean(access || refreshToken);
        // No advertised revocation endpoint means we can't confirm anything.
        let confirmed = hadToken && revocationEndpoint !== null;
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
        const current = (await configs.read()).profiles[config.origin];
        await clearHeld(deps, profile);
        // This folder was signed in again meanwhile: that newer sign-in
        // stays, so "signed out" would be untrue.
        if (current && !sameSignIn(current, profile))
          throw new CliError(
            "CONFLICT",
            "This folder was signed in again while signing out, and that newer sign-in is still active.",
            { exit: EXIT.failure, next: "Run `crisper logout` again." },
          );
        return { revoked: confirmed, hadToken };
      });
    },
    async updateProfile(patch) {
      Object.assign(profile, patch);
      await withLock(configs.lockFile, persistHeld);
    },
  };
  return session;
}
