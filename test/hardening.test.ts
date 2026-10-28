import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { requestDeviceCode } from "../src/auth/device.js";
import { withLock } from "../src/auth/lock.js";
import { discoverAuth } from "../src/auth/metadata.js";
import { loadSession, saveSession } from "../src/auth/session.js";
import { ConfigStore, MemoryStore, secretName } from "../src/auth/store.js";
import { approvalUrl } from "../src/commands/auth.js";
import { type CliConfig } from "../src/config.js";
import { safeJson, safeText, table } from "../src/output.js";

const config: CliConfig = {
  origin: "https://crisper.io",
  clientId: "cid",
  scope: "profile email offline_access",
};

describe("redirects are never followed with credentials", () => {
  it("sends redirect: manual on discovery and device requests and treats 3xx as failure", async () => {
    const inits: RequestInit[] = [];
    const redirecting = (async (_input: unknown, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response("", {
        status: 307,
        headers: { location: "https://evil.example/" },
      });
    }) as unknown as typeof fetch;
    await expect(
      discoverAuth("https://crisper.io", redirecting),
    ).rejects.toMatchObject({
      code: "METADATA_INVALID",
    });
    await expect(
      requestDeviceCode(
        {
          endpoint: "https://issuer.example/d",
          clientId: "cid",
          scope: "profile",
          resource: "r",
        },
        { fetcher: redirecting },
      ),
    ).rejects.toMatchObject({ code: "SERVER_ERROR" });
    for (const init of inits) expect(init.redirect).toBe("manual");
  });
});

describe("approval link policy", () => {
  const issuer = "https://example-app-00.clerk.accounts.dev"; // public-check: allow
  it("accepts https links on the issuer's domain and rejects everything else", () => {
    expect(
      approvalUrl(
        "https://example-app-00.accounts.dev/device?user_code=AB",
        issuer,
      ),
    ).toContain("accounts.dev/device");
    expect(
      approvalUrl(
        "https://accounts.crisper.io/device",
        "https://clerk.crisper.io",
      ),
    ).toBeTruthy();
    expect(approvalUrl("C:\\Windows\\System32\\calc.exe", issuer)).toBeNull();
    expect(
      approvalUrl("http://example-app-00.accounts.dev/device", issuer),
    ).toBeNull();
    expect(approvalUrl("https://evil.example/device", issuer)).toBeNull();
    expect(
      approvalUrl(
        // Built at runtime so the source holds no URL with a password in it.
        `https://user:${"pw"}@example-app-00.accounts.dev/device`,
        issuer,
      ),
    ).toBeNull();
    expect(approvalUrl("file:///etc/passwd", issuer)).toBeNull();
  });
});

describe("device response lifetimes come from the server only", () => {
  it("refuses a device response without a valid expires_in", async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          device_code: "d",
          user_code: "U",
          verification_uri: "https://x.example/d",
          interval: 5,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    await expect(
      requestDeviceCode(
        {
          endpoint: "https://x.example/d",
          clientId: "c",
          scope: "p",
          resource: "r",
        },
        { fetcher },
      ),
    ).rejects.toMatchObject({ code: "SERVER_ERROR" });
  });
});

describe("cross-process refresh", () => {
  async function fixture(fetcher: typeof fetch, now: () => number) {
    const dir = await mkdtemp(join(tmpdir(), "crisperio-lock-"));
    const secrets = new MemoryStore();
    const configs = new ConfigStore(join(dir, "config.json"));
    const deps = { config, secrets, configs, fetcher, now };
    await saveSession(deps, {
      issuer: "https://clerk.example",
      clientId: "cid",
      resource: "https://crisper.io/api/mcp",
      tokenEndpoint: "https://clerk.example/oauth/token",
      revocationEndpoint: "https://clerk.example/oauth/token/revoke",
      tokens: {
        accessToken: "at1",
        refreshToken: "rt1",
        expiresAt: 1,
        scope: null,
      },
    });
    return deps;
  }

  it("two separately loaded sessions refresh once and both end on the new token", async () => {
    let calls = 0;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      const sent = new URLSearchParams(String(init?.body));
      // A second redemption of a rotated token would be invalid_grant.
      if (sent.get("refresh_token") !== "rt1")
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        });
      await new Promise((r) => setTimeout(r, 20));
      return new Response(
        JSON.stringify({
          access_token: "at2",
          refresh_token: "rt2",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const deps = await fixture(fetcher, () => 1_000_000);
    const a = await loadSession(deps);
    const b = await loadSession(deps);
    const [ta, tb] = await Promise.all([a.accessToken(), b.accessToken()]);
    expect(ta).toBe("at2");
    expect(tb).toBe("at2");
    expect(calls).toBe(1);
    expect(
      await deps.secrets.get(secretName(config.origin, "cid", "refresh")),
    ).toBe("rt2");
  });

  it("a stale lock is taken over", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crisperio-lock-"));
    const lock = join(dir, "config.json.lock");
    let t = 1_000_000;
    const now = () => t;
    const sleep = async (ms: number) => {
      t += ms;
    };
    await withLock(lock, async () => "first", sleep, now);
    // Simulate a crashed holder: create the lock and jump the clock past STALE_MS.
    const { open } = await import("node:fs/promises");
    await (await open(lock, "wx")).close();
    t += 60_000;
    expect(await withLock(lock, async () => "second", sleep, now)).toBe(
      "second",
    );
  });

  it("a holder whose lock was taken over leaves the new holder's lock alone", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "crisperio-lock-"));
    const lock = join(dir, "config.json.lock");
    await withLock(lock, async () => {
      // Another process took the lock over while this one was still working.
      await writeFile(lock, "other-holder");
    });
    expect(await readFile(lock, "utf8")).toBe("other-holder");
  });
});

describe("first run on a fresh machine", () => {
  it("creates the config directory (0700) and file (0600) when nothing exists yet", async () => {
    const { stat } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "crisperio-fresh-"));
    const file = join(root, "nested", "crisperio", "config.json");
    const deps = {
      config,
      secrets: new MemoryStore(),
      configs: new ConfigStore(file),
    };
    await saveSession(deps, {
      issuer: "https://clerk.example",
      clientId: "cid",
      resource: "https://crisper.io/api/mcp",
      tokenEndpoint: "https://clerk.example/oauth/token",
      revocationEndpoint: null,
      tokens: {
        accessToken: "at",
        refreshToken: null,
        expiresAt: 1,
        scope: null,
      },
    });
    if (process.platform !== "win32") {
      expect((await stat(join(root, "nested", "crisperio"))).mode & 0o777).toBe(
        0o700,
      );
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect(
      (await deps.configs.read()).profiles["https://crisper.io"]?.clientId,
    ).toBe("cid");
  });

  it("revokes freshly minted tokens when they cannot be stored", async () => {
    const { createProgram } = await import("../src/cli.js");
    const revoked: string[] = [];
    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200 });
      if (url.endsWith("/oauth-protected-resource/api/mcp"))
        return json({
          resource: "https://crisper.io/api/mcp",
          authorization_servers: ["https://clerk.example"],
        });
      if (url.endsWith("/oauth-authorization-server"))
        return json({
          issuer: "https://clerk.example",
          device_authorization_endpoint:
            "https://clerk.example/oauth/device_authorization",
          token_endpoint: "https://clerk.example/oauth/token",
          revocation_endpoint: "https://clerk.example/oauth/token/revoke",
          grant_types_supported: [
            "urn:ietf:params:oauth:grant-type:device_code",
          ],
        });
      if (url.endsWith("/oauth/device_authorization"))
        return json({
          device_code: "d",
          user_code: "U",
          verification_uri: "https://accounts.clerk.example/device",
          expires_in: 600,
          interval: 1,
        });
      if (url.endsWith("/oauth/token"))
        return json({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
        });
      if (url.endsWith("/oauth/token/revoke")) {
        revoked.push(
          new URLSearchParams(String(init?.body)).get("token_type_hint")!,
        );
        return new Response("", { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const broken = {
      async get() {
        return null;
      },
      async set() {
        throw new Error("keychain locked");
      },
      async delete() {},
    };
    const out: string[] = [];
    const { run } = createProgram({
      writer: { out: (s) => out.push(s), err: () => {} },
      context: (mode, signal) => ({
        config,
        mode,
        writer: { out: (s) => out.push(s), err: () => {} },
        secrets: broken,
        configs: new ConfigStore(join(root(), "config.json")),
        fetcher,
        interactive: false,
        openBrowser: async () => {},
        signal,
        now: Date.now,
        prompter: {
          ask: async () => "yes",
          secret: async () => "",
          stdin: async () => "",
        },
        sleep: async () => {},
        resolved: {},
      }),
    });
    function root() {
      return join(tmpdir(), `crisperio-broken-${process.pid}`);
    }
    expect(await run(["--json", "login", "--no-browser"])).toBe(1);
    expect(revoked).toEqual(["refresh_token", "access_token"]);
    expect(out.join("")).not.toContain('at"');
  }, 15_000);
});

describe("terminal and JSON escaping", () => {
  it("escapes newlines, tabs and C1 controls in human output", () => {
    expect(safeText("Clinic\nfake row\tx\u0085")).toBe(
      "Clinic\\x0afake row\\x09x\\x85",
    );
    expect(table([["NAME"], ["a\nb"]])).toBe("NAME\na\\x0ab");
  });
  it("escapes C1 controls in JSON", () => {
    expect(safeJson({ name: "a\u009bb" })).toBe('{"name":"a\\u009bb"}');
    expect(JSON.parse(safeJson({ name: "a\u009bb" }))).toEqual({
      name: "a\u009bb",
    });
  });
});

describe("secret names", () => {
  it("bind the full origin and client", () => {
    expect(secretName("http://localhost:3010", "a", "access")).toBe(
      "http://localhost:3010|a|access",
    );
    expect(secretName("https://localhost:3010", "a", "access")).not.toBe(
      secretName("http://localhost:3010", "a", "access"),
    );
    expect(secretName("https://crisper.io", "a", "access")).not.toBe(
      secretName("https://crisper.io", "b", "access"),
    );
  });
});
