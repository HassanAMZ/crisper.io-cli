import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { clearSession, loadSession, saveSession } from "../src/auth/session.js";
import { ConfigStore, MemoryStore, secretName } from "../src/auth/store.js";
import { type CliConfig } from "../src/config.js";

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
    expect(
      await d.secrets.get(secretName(config.origin, "cid", "access")),
    ).toBe("at1");
    expect(
      await d.secrets.get(secretName(config.origin, "cid", "refresh")),
    ).toBe("rt1");
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
    expect(
      await d.secrets.get(secretName(config.origin, "cid", "refresh")),
    ).toBe("rt2");
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
    expect(
      await d.secrets.get(secretName(config.origin, "cid", "access")),
    ).toBeNull();
    expect(
      await d.secrets.get(secretName(config.origin, "cid", "refresh")),
    ).toBeNull();
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
    expect(await (await loadSession(d)).signOut()).toBe(true);
    expect(hints).toEqual(["refresh_token", "access_token"]);
    expect(
      await d.secrets.get(secretName(config.origin, "cid", "access")),
    ).toBeNull();

    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const d2 = await deps(down);
    expect(await (await loadSession(d2)).signOut()).toBe(false);
    expect(
      await d2.secrets.get(secretName(config.origin, "cid", "refresh")),
    ).toBeNull();
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
});
