import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { SERVICE_NAME } from "../config.js";
import { CliError, EXIT } from "../errors.js";

/**
 * Secrets live in the OS credential store (macOS Keychain, Windows Credential
 * Manager, Linux Secret Service). Access and refresh tokens are separate
 * entries because Windows caps one entry at 2560 bytes. Everything else
 * (which issuer, which account, the chosen org) is plain JSON in the user's
 * config directory with owner-only permissions. There is no plaintext
 * fallback for secrets: on Linux the entry is pinned to Secret Service, so a
 * box without one fails loudly instead of using the reboot-volatile kernel
 * keyring.
 */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  /** Removes the entry. Throws when the store is locked or unreachable. */
  delete(name: string): Promise<void>;
}

export const storageUnavailable = (cause: unknown) =>
  new CliError(
    "STORAGE_UNAVAILABLE",
    `Secure credential storage isn't available on this computer${
      cause instanceof Error && cause.message ? `: ${cause.message}` : "."
    }`,
    {
      exit: EXIT.failure,
      next: "On Linux install and unlock a Secret Service provider (gnome-keyring or KWallet). The CLI never writes tokens to a plain file.",
    },
  );

export class KeyringStore implements SecretStore {
  private lib: Promise<typeof import("@napi-rs/keyring")> | null = null;
  constructor(private readonly service = SERVICE_NAME) {}

  private async entry(name: string) {
    this.lib ??= import("@napi-rs/keyring").catch((e) => {
      throw storageUnavailable(e);
    });
    const { Entry } = await this.lib;
    try {
      return new Entry(this.service, name, {
        linux: { store: "secret-service" },
      });
    } catch (e) {
      throw storageUnavailable(e);
    }
  }

  async get(name: string) {
    const entry = await this.entry(name);
    try {
      return entry.getPassword() ?? null;
    } catch (e) {
      throw storageUnavailable(e);
    }
  }
  async set(name: string, value: string) {
    const entry = await this.entry(name);
    try {
      entry.setPassword(value);
    } catch (e) {
      throw storageUnavailable(e);
    }
  }
  async delete(name: string) {
    const entry = await this.entry(name);
    try {
      // false means it was already absent; a locked store throws.
      entry.deletePassword();
    } catch (e) {
      throw storageUnavailable(e);
    }
  }
}

export class MemoryStore implements SecretStore {
  private map = new Map<string, string>();
  async get(name: string) {
    return this.map.get(name) ?? null;
  }
  async set(name: string, value: string) {
    this.map.set(name, value);
  }
  async delete(name: string) {
    this.map.delete(name);
  }
}

/** Non-secret state. One profile per Crisper origin so dev and prod don't mix. */
export type Profile = {
  origin: string;
  issuer: string;
  clientId: string;
  resource: string;
  /** Discovered at login; refresh and revoke use these, never a guessed path. */
  tokenEndpoint?: string;
  revocationEndpoint?: string | null;
  /** Unix ms when the access token expires; 0 when the issuer gave no lifetime. */
  expiresAt: number;
  scope: string | null;
  /** Clerk user ID, as reported by the server after sign-in. */
  subject: string | null;
  email: string | null;
  defaultOrgId: string | null;
  signedInAt: string;
};

export type ConfigFile = { version: 1; profiles: Record<string, Profile> };

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CRISPER_CONFIG_DIR) return env.CRISPER_CONFIG_DIR;
  if (process.platform === "win32" && env.APPDATA)
    return join(env.APPDATA, SERVICE_NAME);
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), SERVICE_NAME);
}

export class ConfigStore {
  readonly file: string;
  constructor(file = join(configDir(), "config.json")) {
    this.file = file;
  }

  /** Lock file next to the config, used by the session's credential writes. */
  get lockFile() {
    return `${this.file}.lock`;
  }

  async read(): Promise<ConfigFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as ConfigFile).version === 1 &&
        typeof (parsed as ConfigFile).profiles === "object"
      )
        return parsed as ConfigFile;
    } catch {
      // Missing or unreadable: start fresh. Secrets are keyed separately.
    }
    return { version: 1, profiles: {} };
  }

  /**
   * Atomic, owner-only. The directory is ours, so its mode is tightened on
   * every write (POSIX). Windows keeps the user profile's inherited ACL.
   */
  async write(config: ConfigFile) {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
    });
    await chmod(tmp, 0o600).catch(() => {});
    await rename(tmp, this.file);
  }

  async remove() {
    await rm(this.file, { force: true });
  }
}

/**
 * Secrets are keyed by the full origin (scheme included) and the client they
 * were issued to, so an http://localhost profile and an https one, or two
 * Crisper apps, never read each other's tokens.
 */
export const secretName = (
  origin: string,
  clientId: string,
  kind: "access" | "refresh",
) => `${new URL(origin).origin}|${clientId}|${kind}`;
