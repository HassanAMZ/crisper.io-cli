import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadSession, saveSession } from "../src/auth/session.js";
import { ConfigStore, MemoryStore } from "../src/auth/store.js";
import { type CliConfig } from "../src/config.js";

const config: CliConfig = {
  origin: "https://crisper.io",
  clientId: "cid",
  scope: "profile",
};

const args = (
  at: string,
  rt: string,
  revocationEndpoint:
    string | null = "https://clerk.example/oauth/token/revoke",
) => ({
  issuer: "https://clerk.example",
  clientId: "cid",
  resource: "https://crisper.io/api/mcp",
  tokenEndpoint: "https://clerk.example/oauth/token",
  revocationEndpoint,
  tokens: {
    accessToken: at,
    refreshToken: rt,
    expiresAt: 1_000_000 + 3600_000,
    scope: "profile",
  },
});

/** A ConfigStore on the same file whose next read() pauses after reading. */
class PausingStore extends ConfigStore {
  gate: Promise<void> | null = null;
  reached: (() => void) | null = null;
  async read() {
    const v = await super.read();
    if (this.gate) {
      const g = this.gate;
      this.gate = null;
      this.reached?.();
      await g;
    }
    return v;
  }
}

const okFetch = (async () =>
  new Response("", { status: 200 })) as unknown as typeof fetch;

describe("one folder, two processes (TASK-686 review)", () => {
  it("an older process saving its choices never overwrites a newer sign-in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crisperio-"));
    const file = join(dir, "config.json");
    const secrets = new MemoryStore();
    const q = {
      config,
      secrets,
      configs: new ConfigStore(file),
      fetcher: okFetch,
      now: () => 1_000_000,
    };
    await saveSession(q, args("at1", "rt1"));
    const pStore = new PausingStore(file);
    const p = { ...q, configs: pStore };
    const old = await loadSession(p); // process P holds S1

    let release!: () => void;
    pStore.gate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (pStore.reached = r));
    const upd = old.updateProfile({ defaultOrgId: "org_P" }); // `crisper orgs use` in P
    await reached; // P has read the file and checked slot == S1, under the lock

    // Process Q: `crisper login` in the same folder starts and must wait.
    const login = (async () => {
      await (await loadSession(q)).signOut();
      return saveSession(q, args("at2", "rt2"));
    })();
    await new Promise((r) => setTimeout(r, 150));
    release();
    await upd;
    const s2 = await login;

    const after = (await new ConfigStore(file).read()).profiles[
      "https://crisper.io"
    ]!;
    expect(await (await loadSession(q)).accessToken()).toBe("at2");
    expect(after.slot).toBe(s2.slot);
  });

  it("a logout overtaken by a new login says the newer sign-in is still active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crisperio-"));
    const file = join(dir, "config.json");
    const secrets = new MemoryStore();
    const q = {
      config,
      secrets,
      configs: new ConfigStore(file),
      fetcher: okFetch,
      now: () => 1_000_000,
    };
    await saveSession(q, args("at1", "rt1"));
    const logoutSession = await loadSession(q); // `crisper logout` loaded S1
    // Meanwhile `crisper login` (already approved) replaces the sign-in.
    await (await loadSession(q)).signOut();
    await saveSession(q, args("at2", "rt2"));
    await expect(logoutSession.signOut()).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await (await loadSession(q)).accessToken()).toBe("at2");
  });

  it("a sign-in whose config write fails leaves no tokens behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crisperio-"));
    const file = join(dir, "config.json");
    const secrets = new MemoryStore();
    class FailWrite extends ConfigStore {
      async write() {
        throw new Error("disk full");
      }
    }
    const q = {
      config,
      secrets,
      configs: new FailWrite(file),
      fetcher: okFetch,
      now: () => 1_000_000,
    };
    await expect(saveSession(q, args("at1", "rt1", null))).rejects.toThrow(
      "disk full",
    );
    expect(secrets.names()).toEqual([]);
  });
});
