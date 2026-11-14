import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadSession, saveSession } from "../src/auth/session.js";
import { ConfigStore, MemoryStore } from "../src/auth/store.js";
import { login } from "../src/commands/auth.js";
import { type CommandContext } from "../src/commands/context.js";

const ORIGIN = "https://crisper.io";
const ISSUER = "https://clerk.example";
const config = { origin: ORIGIN, clientId: "cid", scope: "profile" };

const qArgs = (at: string, rt: string) => ({
  issuer: ISSUER,
  clientId: "cid",
  resource: `${ORIGIN}/api/mcp`,
  tokenEndpoint: `${ISSUER}/oauth/token`,
  revocationEndpoint: `${ISSUER}/oauth/token/revoke`,
  tokens: {
    accessToken: at,
    refreshToken: rt,
    expiresAt: Date.now() + 3600_000,
    scope: "profile",
  },
});

class GatedStore extends ConfigStore {
  reads = 0;
  pauseOn = -1;
  /** Run the hook before that read instead of after it. */
  hookFirst = false;
  hook: (() => Promise<void>) | null = null;
  async read() {
    this.reads += 1;
    const pause = this.reads === this.pauseOn && this.hook;
    if (pause && this.hookFirst) await this.hook!();
    const v = await super.read();
    if (pause && !this.hookFirst) await this.hook!();
    return v;
  }
}

function fakeFetch(
  revoked: string[],
  onMcp: () => Promise<number>,
  counter = { n: 0 },
) {
  const json = (s: number, b: unknown) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { "content-type": "application/json" },
    });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    if (url === `${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`)
      return json(200, {
        resource: `${ORIGIN}/api/mcp`,
        authorization_servers: [ISSUER],
      });
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`)
      return json(200, {
        issuer: ISSUER,
        device_authorization_endpoint: `${ISSUER}/oauth/device_authorization`,
        token_endpoint: `${ISSUER}/oauth/token`,
        revocation_endpoint: `${ISSUER}/oauth/token/revoke`,
        grant_types_supported: [
          "urn:ietf:params:oauth:grant-type:device_code",
          "refresh_token",
        ],
      });
    if (url === `${ISSUER}/oauth/device_authorization`)
      return json(200, {
        device_code: "d",
        user_code: "AAAA-BBBB",
        verification_uri: `${ISSUER}/device`,
        expires_in: 600,
        interval: 0.001,
      });
    if (url === `${ISSUER}/oauth/token`) {
      counter.n += 1;
      return json(200, {
        access_token: `P-at${counter.n}`,
        refresh_token: `P-rt${counter.n}`,
        expires_in: 3600,
      });
    }
    if (url === `${ISSUER}/oauth/token/revoke`) {
      revoked.push(new URLSearchParams(body).get("token")!);
      return new Response("", { status: 200 });
    }
    if (url === `${ORIGIN}/api/mcp`) {
      if (init?.method !== "POST") return new Response("", { status: 405 });
      return new Response("", { status: await onMcp() });
    }
    return new Response("nf", { status: 404 });
  }) as unknown as typeof fetch;
}

const ctxOf = (
  configs: ConfigStore,
  secrets: MemoryStore,
  fetcher: typeof fetch,
): CommandContext =>
  ({
    config,
    mode: "json",
    writer: { out: () => {}, err: () => {} },
    secrets,
    configs,
    fetcher,
    interactive: false,
    openBrowser: async () => {},
    signal: new AbortController().signal,
    now: () => Date.now(),
    prompter: {} as never,
    sleep: async () => {},
    resolved: {},
  }) as unknown as CommandContext;

describe("a login racing another login in the same folder (TASK-686 review round 2)", () => {
  it("a login the gate refuses never clears a newer sign-in made meanwhile", async () => {
    const file = join(
      await mkdtemp(join(tmpdir(), "crisperio-")),
      "config.json",
    );
    const secrets = new MemoryStore();
    const revoked: string[] = [];
    const q = {
      config,
      secrets,
      configs: new ConfigStore(file),
      fetcher: fakeFetch(revoked, async () => 200),
      now: Date.now,
    };
    let qSlot = "";
    // P's gate call: meanwhile process Q finishes `crisper login` in the same folder.
    const pFetch = fakeFetch(revoked, async () => {
      if (!qSlot) {
        await (await loadSession(q)).signOut();
        qSlot = (await saveSession(q, qArgs("Q-at", "Q-rt"))).slot!;
      }
      return 403;
    });
    await expect(
      login(ctxOf(new ConfigStore(file), secrets, pFetch), { browser: false }),
    ).rejects.toBeTruthy();
    const after = (await new ConfigStore(file).read()).profiles[ORIGIN];
    // Intent: an older process never clears a newer sign-in.
    expect(after?.slot).toBe(qSlot);
    expect(await (await loadSession(q)).accessToken()).toBe("Q-at");
  });

  it("a sign-in replaced by a racing login is revoked, never left live", async () => {
    const file = join(
      await mkdtemp(join(tmpdir(), "crisperio-")),
      "config.json",
    );
    const secrets = new MemoryStore();
    const revoked: string[] = [];
    const base = new ConfigStore(file);
    const q = {
      config,
      secrets,
      configs: base,
      fetcher: fakeFetch(revoked, async () => 200),
      now: Date.now,
    };
    await saveSession(q, qArgs("S1-at", "S1-rt")); // the folder's existing sign-in
    const pStore = new GatedStore(file);
    pStore.pauseOn = 3; // login's first read, hasSession, loadSession
    pStore.hook = async () => {
      // Q: `crisper login` replaces S1 with S2 while P sits between loadSession and signOut.
      await (await loadSession(q)).signOut();
      await saveSession(q, qArgs("S2-at", "S2-rt"));
    };
    const pFetch = fakeFetch(revoked, async () => 200);
    await login(ctxOf(pStore, secrets, pFetch), { browser: false }).catch(
      () => {},
    );
    // The sign-in this login replaced (S2) is revoked, not just forgotten.
    expect(revoked).toEqual(expect.arrayContaining(["S2-rt", "S2-at"]));
  });

  for (const [hookFirst, code] of [
    [true, "CONFLICT"],
    [false, "AUTH_REQUIRED"],
  ] as const)
    it(`a login whose folder was taken by a racing login leaves that sign-in alone (${code})`, async () => {
      const file = join(
        await mkdtemp(join(tmpdir(), "crisperio-")),
        "config.json",
      );
      const secrets = new MemoryStore();
      const revoked: string[] = [];
      const q = {
        config,
        secrets,
        configs: new ConfigStore(file),
        fetcher: fakeFetch(revoked, async () => 200),
        now: Date.now,
      };
      let qSlot = "";
      const pStore = new GatedStore(file);
      pStore.hookFirst = hookFirst;
      pStore.pauseOn = 4; // previous, hasSession, saveSession, then the session load
      pStore.hook = async () => {
        // Q finishes `crisper login` between P's save and P's gate check.
        qSlot = (await saveSession(q, qArgs("Q-at", "Q-rt"))).slot!;
      };
      // P's gate would fail; it must never get that far with Q's sign-in.
      const pFetch = fakeFetch(revoked, async () => 503);
      await expect(
        login(ctxOf(pStore, secrets, pFetch), { browser: false }),
      ).rejects.toMatchObject({ code });
      expect((await new ConfigStore(file).read()).profiles[ORIGIN]?.slot).toBe(
        qSlot,
      );
      expect(revoked).not.toContain("Q-at");
      expect(revoked).not.toContain("Q-rt");
      expect(await (await loadSession(q)).accessToken()).toBe("Q-at");
    });
});
