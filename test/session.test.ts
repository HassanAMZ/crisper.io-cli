import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { clearSession, loadSession, saveSession } from "../src/auth/session.js";
import { ConfigStore, MemoryStore, secretName } from "../src/auth/store.js";
import { type CliConfig } from "../src/config.js";
import { stored } from "./stored.js";

const config: CliConfig = {
  origin: "https://crisper.io",
  clientId: "cid",
  scope: "profile email offline_access",
};

async function deps(fetcher?: typeof fetch, now = () => 1_000_000) {
  const dir = await mkdtemp(join(tmpdir(), "crisperio-"));
  const d = {
    config,
    secrets: new MemoryStore(),
    configs: new ConfigStore(join(dir, "config.json")),
    ...(fetcher ? { fetcher } : {}),
    now,
  };
  await saveSession(d, {
    issuer: "https://clerk.example",
    clientId: "cid",
    resource: "https://crisper.io/api/mcp",
    tokenEndpoint: "https://clerk.example/oauth/token",
    revocationEndpoint: "https://clerk.example/oauth/token/revoke",
    tokens: {
      accessToken: "at1",
      refreshToken: "rt1",
      expiresAt: 1_000_000 + 3600_000,
      scope: "profile",
    },
  });
  return { dir, ...d };
}

describe("session storage", () => {
  it("keeps tokens out of the config file and makes the file owner-only", async () => {
    const d = await deps();
    const file = join(d.dir, "config.json");
    const text = await readFile(file, "utf8");
    expect(text).not.toContain("at1");
    expect(text).not.toContain("rt1");
    expect(JSON.parse(text).profiles["https://crisper.io"].clientId).toBe(
      "cid",
    );
    if (process.platform !== "win32")
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await stored(d.secrets, "access")).toBe("at1");
    expect(await stored(d.secrets, "refresh")).toBe("rt1");
  });

  it("returns the stored token while it is fresh, without a network call", async () => {
    let calls = 0;
    const d = await deps((async () => {
      calls += 1;
      throw new Error("should not be called");
    }) as unknown as typeof fetch);
    const session = await loadSession(d);
    expect(await session.accessToken()).toBe("at1");
    expect(calls).toBe(0);
  });

  it("refreshes once for concurrent callers when the token is about to expire", async () => {
    let calls = 0;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      const sent = new URLSearchParams(String(init?.body));
      expect(sent.get("grant_type")).toBe("refresh_token");
      expect(sent.get("refresh_token")).toBe("rt1");
      expect(sent.get("resource")).toBe("https://crisper.io/api/mcp");
      expect(sent.has("client_secret")).toBe(false);
      return new Response(
        JSON.stringify({
          access_token: "at2",
          refresh_token: "rt2",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const d = await deps(fetcher, () => 1_000_000 + 3600_000 - 30_000);
    const session = await loadSession(d);
    const [a, b] = await Promise.all([
      session.accessToken(),
      session.accessToken(),
    ]);
    expect(a).toBe("at2");
    expect(b).toBe("at2");
    expect(calls).toBe(1);
    expect(await stored(d.secrets, "refresh")).toBe("rt2");
    const saved = await d.configs.read();
    expect(saved.profiles["https://crisper.io"]!.expiresAt).toBe(
      d.now() + 3600_000,
    );
  });

  it("wipes credentials when the refresh token is rejected", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })) as unknown as typeof fetch;
    const d = await deps(fetcher, () => 1_000_000 + 3600_000);
    const session = await loadSession(d);
    await expect(session.accessToken()).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      exit: 3,
    });
    expect(await stored(d.secrets, "access")).toBeNull();
    expect(await stored(d.secrets, "refresh")).toBeNull();
    await expect(loadSession(d)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      exit: 3,
    });
  });

  it("signOut revokes both tokens with the public client ID and clears locally even when the server is down", async () => {
    const hints: string[] = [];
    const ok = (async (_input: unknown, init?: RequestInit) => {
      const sent = new URLSearchParams(String(init?.body));
      hints.push(sent.get("token_type_hint")!);
      expect(sent.get("client_id")).toBe("cid");
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const d = await deps(ok);
    expect(await (await loadSession(d)).signOut()).toEqual({
      revoked: true,
      hadToken: true,
    });
    expect(hints).toEqual(["refresh_token", "access_token"]);
    expect(await stored(d.secrets, "access")).toBeNull();

    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const d2 = await deps(down);
    expect(await (await loadSession(d2)).signOut()).toEqual({
      revoked: false,
      hadToken: true,
    });
    expect(await stored(d2.secrets, "refresh")).toBeNull();
    await expect(loadSession(d2)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("refuses a profile signed in with a different client", async () => {
    const d = await deps();
    await expect(
      loadSession({ ...d, config: { ...config, clientId: "other" } }),
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    await clearSession(d);
  });

  describe("one sign-in per config folder (TASK-686)", () => {
    const tokens = (n: string) => ({
      accessToken: `at-${n}`,
      refreshToken: `rt-${n}`,
      expiresAt: 1_000_000 + 3600_000,
      scope: "profile",
    });
    const save = (d: Awaited<ReturnType<typeof folder>>, n: string) =>
      saveSession(d, {
        issuer: "https://clerk.example",
        clientId: "cid",
        resource: "https://crisper.io/api/mcp",
        tokenEndpoint: "https://clerk.example/oauth/token",
        revocationEndpoint: "https://clerk.example/oauth/token/revoke",
        tokens: tokens(n),
      });
    // A folder of its own on a computer whose credential store is `secrets`.
    async function folder(secrets: MemoryStore, fetcher?: typeof fetch) {
      const dir = await mkdtemp(join(tmpdir(), "crisperio-"));
      return {
        config,
        secrets,
        configs: new ConfigStore(join(dir, "config.json")),
        now: () => 1_000_000,
        ...(fetcher ? { fetcher } : {}),
      };
    }
    const revokes = (sent: string[]) =>
      (async (_input: unknown, init?: RequestInit) => {
        sent.push(new URLSearchParams(String(init?.body)).get("token")!);
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch;

    it("a second folder's sign-in never changes who the first folder acts as", async () => {
      const secrets = new MemoryStore();
      const a = await folder(secrets, revokes([]));
      const b = await folder(secrets, revokes([]));
      await save(a, "a");
      await save(b, "b");
      expect(await (await loadSession(a)).accessToken()).toBe("at-a");
      expect(await (await loadSession(b)).accessToken()).toBe("at-b");
      // Signing out in A leaves B signed in.
      await (await loadSession(a)).signOut();
      await expect(loadSession(a)).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      });
      expect(await (await loadSession(b)).accessToken()).toBe("at-b");
    });

    it("an old shared sign-in is revoked, removed and must sign in again", async () => {
      const secrets = new MemoryStore();
      const sent: string[] = [];
      const d = await folder(secrets, revokes(sent));
      const legacy = (kind: "access" | "refresh") =>
        secretName(config.origin, "cid", kind);
      await secrets.set(legacy("access"), "old-at");
      await secrets.set(legacy("refresh"), "old-rt");
      await d.configs.write({
        version: 1,
        profiles: {
          [config.origin]: {
            origin: config.origin,
            issuer: "https://clerk.example",
            clientId: "cid",
            resource: "https://crisper.io/api/mcp",
            tokenEndpoint: "https://clerk.example/oauth/token",
            revocationEndpoint: "https://clerk.example/oauth/token/revoke",
            expiresAt: 1_000_000 + 3600_000,
            scope: null,
            subject: null,
            email: null,
            defaultOrgId: null,
            signedInAt: "2026-11-01T00:00:00.000Z",
          },
        },
      });
      await expect(loadSession(d)).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
        message: expect.stringContaining("each config folder"),
      });
      expect(sent).toEqual(["old-rt", "old-at"]);
      expect(secrets.names()).toEqual([]);
      expect((await d.configs.read()).profiles).toEqual({});
    });

    it("a slot edited in the file deletes nothing and asks to sign in", async () => {
      const secrets = new MemoryStore();
      const other = await folder(secrets);
      await save(other, "other");
      const d = await folder(secrets);
      const profile = await save(d, "mine");
      const before = secrets.names().length;
      for (const slot of [
        "../x",
        "ABCDEF0123456789ABCDEF0123456789",
        `${profile.slot}|refresh`,
      ]) {
        const file = await d.configs.read();
        file.profiles[config.origin] = { ...profile, slot };
        await d.configs.write(file);
        await expect(loadSession(d)).rejects.toMatchObject({
          code: "AUTH_REQUIRED",
        });
        expect(secrets.names().length).toBe(before);
        expect((await d.configs.read()).profiles).toEqual({});
      }
      expect(await (await loadSession(other)).accessToken()).toBe("at-other");
    });

    it("an older process in the same folder never clears or overwrites a newer sign-in", async () => {
      const secrets = new MemoryStore();
      const d = await folder(secrets, revokes([]));
      await save(d, "first");
      const old = await loadSession(d);
      await save(d, "second");
      // The first sign-in's tokens are gone once the second is saved.
      expect(await stored(secrets, "access")).toBe("at-second");
      await old.updateProfile({ defaultOrgId: "org_old" });
      await expect(old.signOut()).rejects.toMatchObject({ code: "CONFLICT" });
      const now = await loadSession(d);
      expect(now.profile.defaultOrgId).toBeNull();
      expect(await now.accessToken()).toBe("at-second");
    });

    it("signOut says so when no token was left to revoke", async () => {
      const secrets = new MemoryStore();
      const sent: string[] = [];
      const d = await folder(secrets, revokes(sent));
      await save(d, "a");
      const session = await loadSession(d);
      for (const name of secrets.names()) await secrets.delete(name);
      expect(await session.signOut()).toEqual({
        revoked: false,
        hadToken: false,
      });
      expect(sent).toEqual([]);
    });
  });
});
