import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { ConfigStore, MemoryStore, secretName } from "../src/auth/store.js";
import { createProgram } from "../src/cli.js";
import { type CommandContext } from "../src/commands/context.js";
import { type OutputMode, type Writer } from "../src/output.js";
import { type Prompter } from "../src/prompt.js";

const fakePrompter: Prompter = {
  ask: async () => "yes",
  secret: async () => "",
  stdin: async () => "",
};

/**
 * A fake Crisper + Clerk behind one fetch: resource metadata, issuer
 * metadata, device grant, refresh, revoke, and a minimal MCP server that
 * answers initialize and tools/call. Each test tunes `state`.
 */
const ORIGIN = "https://crisper.io";
const ISSUER = "https://clerk.example";

type State = {
  userId?: string | undefined;
  tokenCounter: number;
  pendingPolls: number;
  deny: boolean;
  revokeOk: boolean;
  revoked: string[];
  mcp: (token: string, name: string) => { status: number; body?: unknown };
  calls: { url: string; body: string; auth: string | null }[];
  orgs: { orgId: string; name: string; role: string; siteCount: number }[];
};

function makeFetch(state: State): typeof fetch {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers ?? {});
    const auth = headers.get("authorization");
    state.calls.push({ url, body, auth });
    if (url === `${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`)
      return json(200, {
        resource: `${ORIGIN}/api/mcp`,
        authorization_servers: [ISSUER],
        scopes_supported: ["profile", "email"],
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
        device_code: "device-secret",
        user_code: "AAAA-BBBB",
        verification_uri: `${ISSUER}/device`,
        verification_uri_complete: `${ISSUER}/device?user_code=AAAA-BBBB`,
        expires_in: 600,
        interval: 1,
      });
    if (url === `${ISSUER}/oauth/token`) {
      const sent = new URLSearchParams(body);
      if (sent.get("grant_type") === "refresh_token") {
        state.tokenCounter += 1;
        return json(200, {
          access_token: `access-${state.tokenCounter}`,
          refresh_token: `refresh-${state.tokenCounter}`,
          expires_in: 3600,
        });
      }
      if (state.deny) return json(400, { error: "access_denied" });
      if (state.pendingPolls > 0) {
        state.pendingPolls -= 1;
        return json(400, { error: "authorization_pending" });
      }
      state.tokenCounter += 1;
      return json(200, {
        access_token: `access-${state.tokenCounter}`,
        refresh_token: `refresh-${state.tokenCounter}`,
        expires_in: 3600,
        scope: "profile email offline_access",
      });
    }
    if (url === `${ISSUER}/oauth/token/revoke`) {
      if (!state.revokeOk) throw new TypeError("fetch failed");
      state.revoked.push(new URLSearchParams(body).get("token_type_hint")!);
      return new Response("", { status: 200 });
    }
    if (url === `${ORIGIN}/api/mcp`) {
      if (init?.method === "GET") return new Response("", { status: 405 });
      if (init?.method === "DELETE") return new Response("", { status: 200 });
      const token = auth?.replace(/^Bearer /, "") ?? "";
      const rpc = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: { name?: string };
      };
      const gate = state.mcp(token, rpc.params?.name ?? rpc.method);
      if (gate.status !== 200) return new Response("", { status: gate.status });
      if (rpc.method === "initialize")
        return json(200, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "0" },
          },
        });
      if (rpc.id === undefined) return new Response("", { status: 202 });
      if (rpc.method === "tools/call")
        return json(200, { jsonrpc: "2.0", id: rpc.id, result: gate.body });
      return json(200, { jsonrpc: "2.0", id: rpc.id, result: {} });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const okConnection = (state: State) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        connected: true,
        organizations: state.orgs,
        ...(state.userId ? { user: { id: state.userId } } : {}),
      }),
    },
  ],
  structuredContent: {
    connected: true,
    organizations: state.orgs,
    ...(state.userId ? { user: { id: state.userId } } : {}),
  },
});

function harness() {
  const state: State = {
    tokenCounter: 0,
    pendingPolls: 1,
    deny: false,
    revokeOk: true,
    revoked: [],
    calls: [],
    orgs: [
      {
        orgId: "org_1",
        name: "W70 Test Clinic",
        role: "org:admin",
        siteCount: 1,
      },
    ],
    mcp: () => ({ status: 200, body: okConnection(state) }),
  };
  const out: string[] = [];
  const err: string[] = [];
  const writer: Writer = { out: (s) => out.push(s), err: (s) => err.push(s) };
  const secrets = new MemoryStore();
  let configs: ConfigStore;
  let clock = 1_700_000_000_000;
  const context = (mode: OutputMode, signal: AbortSignal): CommandContext => ({
    config: {
      origin: ORIGIN,
      clientId: "cid",
      scope: "profile email offline_access",
    },
    mode,
    writer,
    secrets,
    configs,
    fetcher: makeFetch(state),
    interactive: false,
    openBrowser: async () => {},
    signal,
    now: () => clock,
    prompter: fakePrompter,
    sleep: async () => {},
    resolved: {},
  });
  const run = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const { run } = createProgram({ context, writer, argv });
    return run(argv);
  };
  return {
    state,
    out,
    err,
    secrets,
    run,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Set the saved default site directly (sites use needs list_sites, which this fake doesn't serve). */
    async setDefaultSite(siteId: string) {
      const file = await configs.read();
      for (const p of Object.values(file.profiles)) p.defaultSiteId = siteId;
      await configs.write(file);
    },
    async defaultSite() {
      const file = await configs.read();
      return Object.values(file.profiles)[0]?.defaultSiteId ?? null;
    },
    async init() {
      configs = new ConfigStore(
        join(await mkdtemp(join(tmpdir(), "crisperio-cli-")), "config.json"),
      );
    },
  };
}

// Device polling sleeps are real but short (interval 1 s); keep the suite quick.
describe("crisper (command contract)", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.init();
  });

  it("usage errors exit 2 and still emit one envelope under --json", async () => {
    expect(await h.run("orgs", "use", "--json")).toBe(2);
    expect(h.out).toHaveLength(1);
    const env = JSON.parse(h.out[0]!);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("INVALID_ARGUMENT");
    expect(await h.run("--json", "nope")).toBe(2);
    expect(h.out).toHaveLength(1);
    // A group without its subcommand is a usage error, not help.
    expect(await h.run("--json", "orgs")).toBe(2);
    expect(JSON.parse(h.out[0]!).error.code).toBe("INVALID_ARGUMENT");
    expect(await h.run("--json", "auth")).toBe(2);
    // Asked-for help and version still succeed.
    expect(await h.run("--help")).toBe(0);
    expect(await h.run("--version")).toBe(0);
  });

  it("accepts --json after the subcommand and never prints tokens", async () => {
    const code = await h.run("login", "--no-browser", "--json");
    expect(code).toBe(0);
    expect(h.out).toHaveLength(1);
    const env = JSON.parse(h.out[0]!);
    expect(env.command).toBe("login");
    expect(env.ok).toBe(true);
    expect(env.data.defaultOrgId).toBe("org_1");
    expect(h.err.join("\n")).toContain("AAAA-BBBB");
    const everything = [...h.out, ...h.err].join("\n");
    expect(everything).not.toContain("device-secret");
    expect(everything).not.toContain("access-");
    expect(everything).not.toContain("refresh-");
    expect(await h.secrets.get(secretName(ORIGIN, "cid", "access"))).toBe(
      "access-1",
    );
    // Every token request carried the resource and no secret.
    for (const c of h.state.calls.filter((c) => c.url.endsWith("/oauth/token")))
      expect(new URLSearchParams(c.body).get("resource")).toBe(
        `${ORIGIN}/api/mcp`,
      );
  }, 15_000);

  it("revokes and clears a sign-in the MCP gate then refuses", async () => {
    h.state.mcp = () => ({ status: 403 });
    expect(await h.run("--json", "login", "--no-browser")).toBe(4);
    expect(h.state.revoked).toEqual(["refresh_token", "access_token"]);
    expect(await h.secrets.get(secretName(ORIGIN, "cid", "access"))).toBeNull();
    expect(await h.run("--json", "auth", "status")).toBe(3);
  }, 15_000);

  it("auth status reports that the session can refresh", async () => {
    await h.run("--json", "login", "--no-browser");
    expect(await h.run("--json", "auth", "status")).toBe(0);
    expect(JSON.parse(h.out[0]!).data.canRefresh).toBe(true);
  }, 15_000);

  it("denial in the browser exits 3", async () => {
    h.state.deny = true;
    expect(await h.run("--json", "login", "--no-browser")).toBe(3);
    expect(JSON.parse(h.out[0]!).error.code).toBe("AUTH_DENIED");
  }, 15_000);

  it("refreshes once on a 401 and retries, then gives up with exit 3", async () => {
    await h.run("--json", "login", "--no-browser");
    h.state.mcp = (token) =>
      token === "access-1"
        ? { status: 401 }
        : { status: 200, body: okConnection(h.state) };
    expect(await h.run("--json", "orgs", "list")).toBe(0);
    expect(await h.secrets.get(secretName(ORIGIN, "cid", "access"))).toBe(
      "access-2",
    );
    h.state.mcp = () => ({ status: 401 });
    expect(await h.run("--json", "orgs", "list")).toBe(3);
    expect(JSON.parse(h.out[0]!).error.code).toBe("AUTH_EXPIRED");
  }, 15_000);

  it("maps server errors by exact text and by status", async () => {
    await h.run("--json", "login", "--no-browser");
    const toolError = (text: string) => ({
      status: 200,
      body: { isError: true, content: [{ type: "text", text }] },
    });
    h.state.mcp = () => toolError("MCP is not enabled.");
    expect(await h.run("--json", "orgs", "list")).toBe(7);
    h.state.mcp = () => toolError("Site unavailable.");
    expect(await h.run("--json", "orgs", "list")).toBe(4);
    h.state.mcp = () => toolError("Rate limit reached. Retry in one minute.");
    expect(await h.run("--json", "orgs", "list")).toBe(5);
    expect(JSON.parse(h.out[0]!).error.retryAfterSeconds).toBe(60);
    h.state.mcp = () => toolError("Something new with token=abc");
    expect(await h.run("--json", "orgs", "list")).toBe(1);
    expect(h.out[0]).not.toContain("abc");
    h.state.mcp = () => ({ status: 429 });
    expect(await h.run("--json", "orgs", "list")).toBe(5);
    h.state.mcp = () => ({ status: 503 });
    expect(await h.run("--json", "orgs", "list")).toBe(7);
  }, 15_000);

  it("logout reports REVOCATION_UNCONFIRMED (exit 8) when the issuer is unreachable, but clears locally", async () => {
    await h.run("--json", "login", "--no-browser");
    h.state.revokeOk = false;
    expect(await h.run("--json", "logout")).toBe(8);
    expect(JSON.parse(h.out[0]!).error.code).toBe("REVOCATION_UNCONFIRMED");
    expect(
      await h.secrets.get(secretName(ORIGIN, "cid", "refresh")),
    ).toBeNull();
    expect(await h.run("--json", "orgs", "list")).toBe(3);
  }, 15_000);

  it("a second login revokes the first session's tokens", async () => {
    await h.run("--json", "login", "--no-browser");
    h.state.pendingPolls = 0;
    await h.run("--json", "login", "--no-browser");
    expect(h.state.revoked).toEqual(["refresh_token", "access_token"]);
    expect(await h.secrets.get(secretName(ORIGIN, "cid", "access"))).toBe(
      "access-2",
    );
  }, 15_000);

  it("keeps the chosen org only when the same person signs in again", async () => {
    h.state.orgs = [
      { orgId: "org_1", name: "A", role: "org:admin", siteCount: 1 },
      { orgId: "org_2", name: "B", role: "org:admin", siteCount: 1 },
    ];
    h.state.userId = "user_1";
    await h.run("--json", "login", "--no-browser");
    expect(await h.run("--json", "orgs", "use", "org_2")).toBe(0);
    await h.setDefaultSite("w_2");
    h.state.pendingPolls = 0;
    await h.run("--json", "login", "--no-browser");
    expect(JSON.parse(h.out[0]!).data.defaultOrgId).toBe("org_2");
    expect(await h.defaultSite()).toBe("w_2");
    h.state.userId = "user_2";
    await h.run("--json", "login", "--no-browser");
    expect(JSON.parse(h.out[0]!).data.defaultOrgId).toBeNull();
    expect(await h.defaultSite()).toBeNull();
    // A server without user IDs never carries a choice over.
    h.state.userId = undefined;
    await h.run("--json", "orgs", "use", "org_2");
    await h.run("--json", "login", "--no-browser");
    expect(JSON.parse(h.out[0]!).data.defaultOrgId).toBeNull();
  }, 30_000);

  it("human mode escapes server strings and keeps stdout clean on failure", async () => {
    h.state.orgs = [
      {
        orgId: "org_1",
        name: "Clinic\u001b[2J",
        role: "org:admin",
        siteCount: 2,
      },
    ];
    await h.run("--json", "login", "--no-browser");
    expect(await h.run("orgs", "list")).toBe(0);
    expect(h.out.join("\n")).toContain("Clinic\\x1b[2J");
    h.state.mcp = () => ({ status: 503 });
    expect(await h.run("orgs", "list")).toBe(7);
    expect(h.out).toHaveLength(0);
    expect(h.err.join("\n")).toContain("paused");
  }, 15_000);
});
