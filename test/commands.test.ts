import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { saveSession } from "../src/auth/session.js";
import { ConfigStore, MemoryStore } from "../src/auth/store.js";
import { createProgram } from "../src/cli.js";
import { type CommandContext } from "../src/commands/context.js";
import { nextStep } from "../src/commands/sites.js";
import { type OutputMode, type Writer } from "../src/output.js";
import { type Prompter } from "../src/prompt.js";

/**
 * A signed-in CLI against a fake Crisper MCP. Each test sets `tools[name]`
 * to answer a tool call; `calls` records what the CLI sent.
 */
const ORIGIN = "https://crisper.io";
type Reply =
  | { result: Record<string, unknown> }
  | { error: string; code?: string }
  | { httpStatus: number };

function harness() {
  const tools: Record<string, (args: Record<string, unknown>) => Reply> = {};
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const answers: string[] = [];
  const requests: { url: string; method: string }[] = [];
  let asked = 0;
  let stdinReads = 0;
  let secret = "";
  let secretAsked = 0;
  let stdin = "";
  const out: string[] = [];
  const err: string[] = [];
  const writer: Writer = { out: (s) => out.push(s), err: (s) => err.push(s) };
  const secrets = new MemoryStore();
  let configs: ConfigStore;
  let clock = 1_700_000_000_000;
  let interactive = true;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET" });
    if (url !== `${ORIGIN}/api/mcp`) return new Response("", { status: 404 });
    if (init?.method === "GET") return new Response("", { status: 405 });
    if (init?.method === "DELETE") return new Response("", { status: 200 });
    const rpc = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
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
    if (rpc.method !== "tools/call")
      return json(200, { jsonrpc: "2.0", id: rpc.id, result: {} });
    const name = rpc.params!.name!;
    const args = rpc.params!.arguments ?? {};
    calls.push({ name, args });
    const handler = tools[name];
    if (!handler) throw new Error(`unexpected tool ${name}`);
    const reply = handler(args);
    if ("httpStatus" in reply)
      return new Response("", { status: reply.httpStatus });
    const result =
      "error" in reply
        ? {
            isError: true,
            content: [{ type: "text", text: reply.error }],
            ...(reply.code
              ? { _meta: { "io.crisper/errorCode": reply.code } }
              : {}),
          }
        : {
            content: [{ type: "text", text: JSON.stringify(reply.result) }],
            structuredContent: reply.result,
          };
    return json(200, { jsonrpc: "2.0", id: rpc.id, result });
  }) as unknown as typeof fetch;

  const prompter: Prompter = {
    ask: async () => {
      asked += 1;
      return answers.shift() ?? "";
    },
    secret: async () => {
      secretAsked += 1;
      return secret;
    },
    stdin: async () => {
      stdinReads += 1;
      return stdin;
    },
    choose: async () => null,
  };
  const context = (mode: OutputMode, signal: AbortSignal): CommandContext => ({
    config: { origin: ORIGIN, clientId: "cid", scope: "profile" },
    mode,
    writer,
    secrets,
    configs,
    fetcher,
    interactive,
    openBrowser: async () => {},
    signal,
    now: () => clock,
    prompter,
    sleep: async (ms) => {
      clock += ms;
    },
    resolved: {},
  });

  return {
    tools,
    calls,
    requests,
    asked: () => asked,
    stdinReads: () => stdinReads,
    out,
    err,
    answers,
    setSecret: (s: string) => (secret = s),
    setStdin: (s: string) => (stdin = s),
    setInteractive: (v: boolean) => (interactive = v),
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    json: () => JSON.parse(out[0]!),
    async init() {
      configs = new ConfigStore(
        join(await mkdtemp(join(tmpdir(), "crisperio-cmd-")), "config.json"),
      );
      await saveSession(
        {
          config: context(
            { json: true, color: false },
            new AbortController().signal,
          ).config,
          secrets,
          configs,
        },
        {
          issuer: "https://clerk.example",
          clientId: "cid",
          resource: `${ORIGIN}/api/mcp`,
          tokenEndpoint: "https://clerk.example/oauth/token",
          revocationEndpoint: "https://clerk.example/oauth/token/revoke",
          tokens: {
            accessToken: "at",
            refreshToken: "rt",
            expiresAt: clock + 3_600_000,
            scope: "profile",
          },
        },
      );
    },
    secretAsked: () => secretAsked,
    async run(...argv: string[]) {
      out.length = 0;
      err.length = 0;
      calls.length = 0;
      requests.length = 0;
      const { run } = createProgram({ context, writer, argv });
      return run(argv);
    },
    /** Run with a controller the test can abort mid-request. */
    async runWith(controller: AbortController, ...argv: string[]) {
      out.length = 0;
      err.length = 0;
      calls.length = 0;
      requests.length = 0;
      const { run } = createProgram({
        context,
        writer,
        argv,
        signal: controller.signal,
      });
      return run(argv);
    },
    /** Run with Ctrl-C already pressed. */
    async runAborted(...argv: string[]) {
      out.length = 0;
      err.length = 0;
      calls.length = 0;
      requests.length = 0;
      const controller = new AbortController();
      controller.abort();
      const { run } = createProgram({
        context,
        writer,
        argv,
        signal: controller.signal,
      });
      return run(argv);
    },
    async profile() {
      return Object.values((await configs.read()).profiles)[0]!;
    },
  };
}

const ORG = {
  orgId: "org_0000000001",
  name: "Clinic",
  role: "org:admin",
  siteCount: 2,
};
const SITES = [
  {
    websiteId: "w1",
    domain: "clinic.com",
    siteType: "wordpress",
    dashboardUrl: "https://crisper.io/dashboard/clinic-com",
  },
  {
    websiteId: "w2",
    domain: "shop.clinic.com",
    siteType: "shopify",
    dashboardUrl: "https://crisper.io/dashboard/shop",
  },
];

describe("site commands", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.init();
    h.tools.get_connection = () => ({
      result: {
        connected: true,
        organizations: [ORG],
        user: { id: "user_1" },
        instructions: "",
      },
    });
    h.tools.list_sites = () => ({
      result: { orgId: "org_0000000001", sites: SITES, truncated: false },
    });
  });

  it("lists sites of the only organization", async () => {
    expect(await h.run("--json", "sites", "list")).toBe(0);
    const env = h.json();
    expect(env.context.orgId).toBe("org_0000000001");
    expect(env.data.sites.map((s: { domain: string }) => s.domain)).toEqual([
      "clinic.com",
      "shop.clinic.com",
    ]);
    expect(h.calls.find((c) => c.name === "list_sites")?.args).toEqual({
      orgId: "org_0000000001",
    });
  });

  it("resolves --site by domain inside the organization, never across", async () => {
    h.tools.get_site_setup = () => ({
      result: {
        websiteId: "w2",
        orgId: "org_0000000001",
        domain: "shop.clinic.com",
        setup: {
          billing: true,
          domainVerified: false,
          scriptsGenerated: false,
          integrationAttached: false,
        },
        billingStatus: "active",
        note: "",
        nextUrls: {},
      },
    });
    expect(
      await h.run(
        "--json",
        "sites",
        "status",
        "--site",
        "https://WWW.shop.clinic.com/",
      ),
    ).toBe(0);
    const env = h.json();
    expect(h.calls.find((c) => c.name === "get_site_setup")?.args).toEqual({
      websiteId: "w2",
    });
    expect(env.context.siteId).toBe("w2");
    expect(env.data.next.step).toBe("dns");
    expect(
      await h.run("--json", "sites", "status", "--site", "other.com"),
    ).toBe(4);
    expect(h.calls.some((c) => c.name === "get_site_setup")).toBe(false);
  });

  it("asks for a site when the organization has several and none is chosen", async () => {
    expect(await h.run("--json", "dns", "records")).toBe(2);
    expect(h.json().error.next).toContain("crisper sites use");
  });

  it("sites use remembers the site; orgs use to another org forgets it", async () => {
    h.tools.get_dns_records = () => ({
      result: {
        websiteId: "w1",
        orgId: "org_0000000001",
        domain: "clinic.com",
        trackingDomain: "t.clinic.com",
        state: "waiting",
        records: [{ type: "CNAME", host: "t", value: "x.stape.io" }],
        problem: null,
        dnsProvider: null,
        lastCheckedAt: null,
        instructions: "",
      },
    });
    expect(await h.run("--json", "sites", "use", "clinic.com")).toBe(0);
    expect(await h.run("--json", "dns", "records")).toBe(0);
    expect(h.calls.find((c) => c.name === "get_dns_records")?.args).toEqual({
      websiteId: "w1",
    });
    h.tools.get_connection = () => ({
      result: {
        connected: true,
        organizations: [
          ORG,
          { ...ORG, orgId: "org_0000000002", name: "Other" },
        ],
        instructions: "",
      },
    });
    expect(await h.run("--json", "orgs", "use", "org_0000000002")).toBe(0);
    h.tools.list_sites = () => ({
      result: { orgId: "org_0000000002", sites: [], truncated: false },
    });
    expect(await h.run("--json", "dns", "records")).toBe(6);
  });

  it("next step follows the product order", () => {
    const all = {
      billing: true,
      domainVerified: true,
      scriptsGenerated: true,
      integrationAttached: true,
    };
    expect(
      nextStep({ ...all, billing: false, domainVerified: false }, "a.com").step,
    ).toBe("billing");
    expect(nextStep({ ...all, domainVerified: false }, "a.com").step).toBe(
      "dns",
    );
    expect(nextStep({ ...all, scriptsGenerated: false }, "a.com").step).toBe(
      "install",
    );
    expect(nextStep({ ...all, integrationAttached: false }, "a.com").step).toBe(
      "integrations",
    );
    expect(nextStep(all, "a.com").step).toBe("verify");
  });

  it("sites add needs a yes, sends the founder defaults, and remembers the new site", async () => {
    h.tools.create_site = (args) => ({
      result: {
        websiteId: "w9",
        orgId: "org_0000000001",
        domain: String(args.domain),
        status: "created",
        replay: false,
        next: "",
        billingUrl: "",
        integrationsUrl: "",
      },
    });
    h.setInteractive(false);
    expect(
      await h.run("--json", "sites", "add", "new.com", "--type", "shopify"),
    ).toBe(2);
    expect(h.calls.some((c) => c.name === "create_site")).toBe(false);
    expect(
      await h.run(
        "--json",
        "sites",
        "add",
        "https://www.New.com/",
        "--type",
        "shopify",
        "--yes",
      ),
    ).toBe(0);
    const args = h.calls.find((c) => c.name === "create_site")!.args;
    expect(args).toMatchObject({
      orgId: "org_0000000001",
      domain: "new.com",
      siteType: "shopify",
      currency: "USD",
      restricted: true,
    });
    expect(typeof args.timezone).toBe("string");
    expect(h.json().data.next.step).toBe("billing");
    expect(
      await h.run("--json", "sites", "add", "x.com", "--type", "nope", "--yes"),
    ).toBe(2);
  });

  it("a write that fails without a clear answer exits 8, not 1", async () => {
    h.tools.create_site = () => ({
      error: "Website creation could not be verified.",
      code: "failed",
    });
    expect(
      await h.run(
        "--json",
        "sites",
        "add",
        "new.com",
        "--type",
        "other",
        "--yes",
      ),
    ).toBe(8);
    expect(h.json().error.code).toBe("WRITE_UNCONFIRMED");
  });
});

describe("error codes from the server", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.init();
    h.tools.get_connection = () => ({
      result: { connected: true, organizations: [ORG], instructions: "" },
    });
    h.tools.list_sites = () => ({
      result: { orgId: "org_0000000001", sites: [SITES[0]], truncated: false },
    });
  });

  it.each([
    ["tracking_not_ready", 6, "CUSTOMER_ACTION_REQUIRED"],
    ["site_unavailable", 4, "ACCESS_DENIED"],
    ["rate_limited", 5, "RATE_LIMITED"],
    ["not_enabled", 7, "CAPABILITY_UNAVAILABLE"],
    ["unavailable", 1, "SERVER_ERROR"],
    ["invalid_argument", 2, "INVALID_ARGUMENT"],
    ["internal", 1, "SERVER_ERROR"],
  ])("%s → exit %i", async (code, exit, cliCode) => {
    h.tools.get_install_snippet = () => ({
      error: `Message for ${code}.`,
      code,
    });
    expect(await h.run("--json", "install", "snippet")).toBe(exit);
    expect(h.json().error.code).toBe(cliCode);
  });

  it("shows Crisper's own message for a known code, a generic one for internal", async () => {
    h.tools.get_install_snippet = () => ({
      error: "Tracking isn't set up for this site yet.",
      code: "tracking_not_ready",
    });
    await h.run("--json", "install", "snippet");
    expect(h.json().error.message).toBe(
      "Tracking isn't set up for this website yet: Crisper creates the tracking domain once billing is active.",
    );
    h.tools.get_install_snippet = () => ({
      error: "stack trace token=abc",
      code: "internal",
    });
    await h.run("--json", "install", "snippet");
    expect(h.json().error.message).not.toContain("abc");
  });
});

describe("dns, events, integrations and billing", () => {
  let h: ReturnType<typeof harness>;
  const site = {
    websiteId: "w1",
    orgId: "org_0000000001",
    domain: "clinic.com",
  };
  beforeEach(async () => {
    h = harness();
    await h.init();
    h.tools.get_connection = () => ({
      result: { connected: true, organizations: [ORG], instructions: "" },
    });
    h.tools.list_sites = () => ({
      result: { orgId: "org_0000000001", sites: [SITES[0]], truncated: false },
    });
  });

  it("dns check exits 6 with the state until verified, 0 when verified", async () => {
    const dns = (state: string) => ({
      result: {
        ...site,
        trackingDomain: "t.clinic.com",
        state,
        records: [{ type: "CNAME", host: "t", value: "x.stape.io" }],
        problem: null,
        dnsProvider: null,
        lastCheckedAt: null,
        instructions: "",
        checkedNow: true,
      },
    });
    h.tools.check_dns = () => dns("waiting");
    expect(await h.run("--json", "dns", "check")).toBe(6);
    expect(h.json().data.records[0].type).toBe("CNAME");
    h.tools.check_dns = () => dns("verified");
    expect(await h.run("--json", "dns", "check")).toBe(0);
  });

  it("events verify waits, asking again each minute, then succeeds", async () => {
    let n = 0;
    h.tools.check_event = (args) => {
      n += 1;
      return {
        result: {
          websiteId: "w1",
          orgId: "org_0000000001",
          event: args.event,
          since: "t",
          checkedAt: "t",
          found: n >= 3,
          count: n >= 3 ? 1 : 0,
          partial: false,
          latest:
            n >= 3
              ? { time: "12:00", client: "c", receivedStatus: "200", path: "/" }
              : null,
          note: "",
        },
      };
    };
    expect(
      await h.run(
        "--json",
        "events",
        "verify",
        "--type",
        "purchase",
        "--wait",
        "5",
      ),
    ).toBe(0);
    expect(n).toBe(3);
    expect(
      h.calls.every(
        (c) => c.name !== "check_event" || c.args.event === "Purchase",
      ),
    ).toBe(true);
    expect(h.err.filter((l) => l.startsWith("Not yet"))).toHaveLength(2);
  });

  it("events verify without --wait exits 6 when nothing arrived", async () => {
    h.tools.check_event = () => ({
      result: {
        websiteId: "w1",
        orgId: "org_0000000001",
        event: "GenerateLead",
        since: "t",
        checkedAt: "t",
        found: false,
        count: 0,
        partial: false,
        latest: null,
        note: "",
      },
    });
    expect(await h.run("--json", "events", "verify", "--type", "lead")).toBe(6);
    expect(h.json().error.code).toBe("NOT_OBSERVED");
    expect(
      await h.run("--json", "events", "verify", "--type", "pageview"),
    ).toBe(2);
  });

  it("integrations connect reads the token hidden, never prints it, and needs a yes", async () => {
    const token = "EAAB" + "x".repeat(40);
    h.tools.connect_integration = (args) => ({
      result: {
        ...site,
        integrationId: "i1",
        platform: args.platform,
        pixelId: args.pixelId,
        status: "connected",
        attached: true,
        note: "",
      },
    });
    h.setSecret(token);
    h.answers.push("no");
    expect(
      await h.run(
        "integrations",
        "connect",
        "--platform",
        "meta",
        "--pixel",
        "1234567890",
      ),
    ).toBe(2);
    expect(h.calls.some((c) => c.name === "connect_integration")).toBe(false);
    h.answers.push("yes");
    expect(
      await h.run(
        "integrations",
        "connect",
        "--platform",
        "meta",
        "--pixel",
        "1234567890",
      ),
    ).toBe(0);
    expect(
      h.calls.find((c) => c.name === "connect_integration")?.args,
    ).toMatchObject({
      websiteId: "w1",
      platform: "meta",
      pixelId: "1234567890",
      accessToken: token,
    });
    expect([...h.out, ...h.err].join("\n")).not.toContain(token);
  });

  it("integrations connect --token-stdin needs --yes and never prompts", async () => {
    const token = "TT" + "y".repeat(40);
    h.tools.connect_integration = (args) => ({
      result: {
        ...site,
        integrationId: "i1",
        platform: args.platform,
        pixelId: args.pixelId,
        status: "updated",
        attached: true,
        note: "",
      },
    });
    h.setStdin(token);
    expect(
      await h.run(
        "--json",
        "integrations",
        "connect",
        "--platform",
        "tiktok",
        "--pixel",
        "CABCDEFGHIJ",
        "--token-stdin",
      ),
    ).toBe(2);
    expect(
      await h.run(
        "--json",
        "integrations",
        "connect",
        "--platform",
        "tiktok",
        "--pixel",
        "CABCDEFGHIJ",
        "--token-stdin",
        "--yes",
      ),
    ).toBe(0);
    expect([...h.out, ...h.err].join("\n")).not.toContain(token);
  });

  it("integration_taken exits 4 as a conflict", async () => {
    h.tools.connect_integration = () => ({
      error: "This pixel is already connected to another organization.",
      code: "integration_taken",
    });
    h.setSecret("EAAB" + "z".repeat(40));
    expect(
      await h.run(
        "--json",
        "integrations",
        "connect",
        "--platform",
        "meta",
        "--pixel",
        "1234567890",
        "--yes",
      ),
    ).toBe(4);
    expect(h.json().error.code).toBe("CONFLICT");
  });

  it("billing cancel: first call, a typed yes, then the confirmation goes back", async () => {
    h.tools.cancel_billing = (args) =>
      args.confirmation
        ? {
            result: {
              ...site,
              status: "cancel_requested",
              currentPeriodEnd: "2026-11-28T00:00:00.000Z",
            },
          }
        : {
            result: {
              ...site,
              status: "confirmation_required",
              currentPeriodEnd: "2026-11-28T00:00:00.000Z",
              plan: "Recovery",
              confirmation: "c-123",
            },
          };
    h.answers.push("yes");
    expect(await h.run("billing", "cancel")).toBe(0);
    const cancels = h.calls.filter((c) => c.name === "cancel_billing");
    expect(cancels.map((c) => c.args.confirmation)).toEqual([
      undefined,
      "c-123",
    ]);
    expect(h.out.join("\n")).toContain("ends on 2026-11-28");
  });

  it("billing cancel without a yes changes nothing", async () => {
    h.tools.cancel_billing = () => ({
      result: {
        ...site,
        status: "confirmation_required",
        currentPeriodEnd: null,
        confirmation: "c-1",
      },
    });
    h.answers.push("nope");
    expect(await h.run("--json", "billing", "cancel")).toBe(2);
    expect(h.calls.filter((c) => c.name === "cancel_billing")).toHaveLength(1);
  });

  it("billing cancel on an already scheduled site makes one call", async () => {
    h.tools.cancel_billing = () => ({
      result: {
        ...site,
        status: "already_scheduled",
        currentPeriodEnd: "2026-11-28T00:00:00.000Z",
      },
    });
    expect(await h.run("--json", "billing", "cancel", "--yes")).toBe(0);
    expect(h.calls.filter((c) => c.name === "cancel_billing")).toHaveLength(1);
  });
});

describe("review round 1 regressions (Astra)", () => {
  let h: ReturnType<typeof harness>;
  const site = {
    websiteId: "w1",
    orgId: "org_0000000001",
    domain: "clinic.com",
  };
  beforeEach(async () => {
    h = harness();
    await h.init();
    h.tools.get_connection = () => ({
      result: { connected: true, organizations: [ORG], instructions: "" },
    });
    h.tools.list_sites = () => ({
      result: { orgId: "org_0000000001", sites: [SITES[0]], truncated: false },
    });
  });

  it("never picks 'the only site' from a truncated list", async () => {
    h.tools.list_sites = () => ({
      result: { orgId: "org_0000000001", sites: [SITES[0]], truncated: true },
    });
    h.tools.cancel_billing = () => ({
      result: { ...site, status: "already_scheduled", currentPeriodEnd: null },
    });
    expect(await h.run("--json", "billing", "cancel", "--yes")).toBe(2);
    expect(h.calls.some((c) => c.name === "cancel_billing")).toBe(false);
    expect(
      await h.run(
        "--json",
        "billing",
        "cancel",
        "--yes",
        "--site",
        "clinic.com",
      ),
    ).toBe(0);
  });

  it("a write that gets an HTTP 500 exits 8, never a retryable 1", async () => {
    h.tools.get_connection = () => ({
      result: { connected: true, organizations: [ORG], instructions: "" },
    });
    h.tools.create_site = () => ({ httpStatus: 500 });
    expect(
      await h.run(
        "--json",
        "sites",
        "add",
        "new.com",
        "--type",
        "other",
        "--yes",
      ),
    ).toBe(8);
    expect(h.json().error.code).toBe("WRITE_UNCONFIRMED");
    h.tools.get_install_snippet = () => ({ httpStatus: 500 });
    expect(await h.run("--json", "install", "snippet")).toBe(1);
  });

  it("escapes server strings in confirmations and strips control bytes from scripts", async () => {
    h.tools.cancel_billing = () => ({
      result: {
        ...site,
        status: "confirmation_required",
        currentPeriodEnd: "x\u001b[2J",
        plan: "Plan\u001b]52;c;Zm9v\u0007",
        confirmation: "c",
      },
    });
    h.answers.push("no");
    await h.run("billing", "cancel");
    expect(h.err.join("\n")).not.toContain("\u001b");
    h.tools.get_install_snippet = () => ({
      result: {
        ...site,
        platform: "custom",
        platformLabel: "Custom",
        installPath: "paste",
        headScript: "<script>\n\tx()\u001b]52;c;Zm9v\u0007</script>",
        bodyScript: "",
        steps: null,
        closingHint: null,
        instructions: "",
        note: "",
      },
    });
    expect(await h.run("install", "snippet")).toBe(0);
    const out = h.out.join("\n");
    expect(out).toContain("<script>\n\tx()]52;c;Zm9v</script>");
    expect(out).not.toContain("\u001b");
  });

  it("app installs render step notes and offer the scripts only as a fallback", async () => {
    h.tools.get_install_snippet = () => ({
      result: {
        ...site,
        platform: "shopify",
        platformLabel: "Shopify",
        installPath: "app",
        headScript: "<script>h()</script>",
        bodyScript: "",
        steps: [
          {
            id: "a",
            title: "Add custom pixel",
            where: "Shopify admin",
            notes: [{ label: "Privacy", text: "Set to Not required" }],
          },
        ],
        closingHint: null,
        instructions: "",
        note: "",
      },
    });
    expect(await h.run("install", "snippet")).toBe(0);
    const out = h.out.join("\n");
    expect(out).toContain("Privacy: Set to Not required");
    expect(out).toContain("Only if you can't use the app");
  });

  it("dns records with nothing to add exits 6; failures keep the resolved site in context", async () => {
    h.tools.get_dns_records = () => ({
      result: {
        ...site,
        trackingDomain: null,
        state: "not_created",
        records: [],
        problem: null,
        dnsProvider: null,
        lastCheckedAt: null,
        instructions: "",
      },
    });
    expect(await h.run("--json", "dns", "records")).toBe(6);
    const env = h.json();
    expect(env.context).toMatchObject({
      orgId: "org_0000000001",
      siteId: "w1",
    });
    expect(env.data.state).toBe("not_created");
  });

  const check = (found: boolean, extra: Record<string, unknown> = {}) => ({
    result: {
      websiteId: "w1",
      orgId: "org_0000000001",
      event: "Purchase",
      since: "s",
      checkedAt: "c",
      found,
      count: found ? 1 : 0,
      partial: false,
      latest: null,
      note: "",
      ...extra,
    },
  });

  it("events verify keeps polling once a minute even when a request is slow", async () => {
    let n = 0;
    h.tools.check_event = () => {
      n += 1;
      h.advance(5_000); // each request takes 5 s
      return check(false);
    };
    expect(
      await h.run(
        "--json",
        "events",
        "verify",
        "--type",
        "purchase",
        "--wait",
        "1",
      ),
    ).toBe(6);
    expect(n).toBe(2);
  });

  it("events verify freezes the window: a widened request can't let an older event pass", async () => {
    const started = h.now();
    const sent: number[] = [];
    h.tools.check_event = (args) => {
      sent.push(Number(args.sinceMinutes));
      h.advance(61_000);
      // Stape answers with an event from before the original 1-minute window.
      return check(true, {
        latest: {
          time: new Date(started - 90_000).toISOString(),
          client: "c",
          receivedStatus: "200",
          path: "/",
        },
      });
    };
    expect(
      await h.run(
        "--json",
        "events",
        "verify",
        "--type",
        "purchase",
        "--since",
        "1",
        "--wait",
        "2",
      ),
    ).toBe(6);
    expect(sent[0]).toBe(1);
    expect(sent.slice(1).every((m) => m >= 2)).toBe(true);
  });

  it("partial answers end as unknown (exit 7), not as absence", async () => {
    h.tools.check_event = () => check(false, { partial: true });
    expect(
      await h.run("--json", "events", "verify", "--type", "purchase"),
    ).toBe(7);
    expect(h.json().error.code).toBe("EVIDENCE_INCOMPLETE");
  });

  it("an empty but truncated integration list doesn't claim there are none", async () => {
    h.tools.list_integrations = () => ({
      result: { ...site, integrations: [], truncated: true },
    });
    expect(await h.run("integrations", "list")).toBe(0);
    expect(h.out.join("\n")).toContain("first 50");
    expect(h.out.join("\n")).not.toContain("yet");
  });

  it.each([
    ["no_subscription", 6, "CUSTOMER_ACTION_REQUIRED"],
    ["confirmation_invalid", 2, "INVALID_ARGUMENT"],
    ["in_progress", 1, "SERVER_ERROR"],
    ["org_required", 2, "INVALID_ARGUMENT"],
    ["domain_taken", 4, "CONFLICT"],
  ])("%s maps to exit %i", async (code, exit, cliCode) => {
    h.tools.cancel_billing = () => ({
      error:
        "Server text. The change may have completed. Check get_connection and list_sites before retrying a create request.",
      code,
    });
    expect(await h.run("--json", "billing", "cancel", "--yes")).toBe(exit);
    const env = h.json();
    expect(env.error.code).toBe(cliCode);
    expect(env.error.message).not.toContain("get_connection");
  });
});

describe("review round 2 regressions (Astra r2, Fable)", () => {
  let h: ReturnType<typeof harness>;
  const site = {
    websiteId: "w1",
    orgId: "org_0000000001",
    domain: "clinic.com",
  };
  const check = (found: boolean, extra: Record<string, unknown> = {}) => ({
    result: {
      websiteId: "w1",
      orgId: "org_0000000001",
      event: "Purchase",
      since: new Date(h.now() - 30 * 60_000).toISOString(),
      checkedAt: new Date(h.now()).toISOString(),
      found,
      count: found ? 1 : 0,
      partial: false,
      latest: null,
      note: "",
      ...extra,
    },
  });
  beforeEach(async () => {
    h = harness();
    await h.init();
    h.tools.get_connection = () => ({
      result: { connected: true, organizations: [ORG], instructions: "" },
    });
    h.tools.list_sites = () => ({
      result: { orgId: "org_0000000001", sites: [SITES[0]], truncated: false },
    });
  });

  it("escapes the user's own values in the sites add confirmation", async () => {
    h.tools.create_site = () => ({
      result: {
        websiteId: "w9",
        orgId: "org_0000000001",
        domain: "n.com",
        status: "created",
        replay: false,
        next: "",
        billingUrl: "",
        integrationsUrl: "",
      },
    });
    await h.run(
      "sites",
      "add",
      "n.com",
      "--type",
      "other",
      "--timezone",
      "Asia/X\u001b[2J",
      "--currency",
      "us\u001b",
      "--yes",
    );
    expect(h.err.join("\n")).not.toContain("\u001b");
  });

  it("slow polls never run past the deadline", async () => {
    let n = 0;
    h.tools.check_event = () => {
      n += 1;
      h.advance(61_000);
      return check(false);
    };
    expect(
      await h.run(
        "--json",
        "events",
        "verify",
        "--type",
        "purchase",
        "--wait",
        "2",
      ),
    ).toBe(6);
    expect(n).toBe(2);
  });

  it("a retryable error during --wait waits and tries again", async () => {
    let n = 0;
    h.tools.check_event = () => {
      n += 1;
      return n === 1
        ? {
            error: "Rate limit reached. Retry in one minute.",
            code: "rate_limited",
          }
        : check(true, {
            latest: {
              time: new Date(h.now()).toISOString(),
              client: "c",
              receivedStatus: "200",
              path: "/",
            },
          });
    };
    expect(
      await h.run(
        "--json",
        "events",
        "verify",
        "--type",
        "purchase",
        "--wait",
        "3",
      ),
    ).toBe(0);
    expect(n).toBe(2);
  });

  it("Ctrl-C before anything is sent exits 130 without a tool call", async () => {
    h.tools.check_event = () => check(true);
    expect(
      await h.runAborted("--json", "events", "verify", "--type", "purchase"),
    ).toBe(130);
    expect(h.calls.some((c) => c.name === "check_event")).toBe(false);
  });

  it("billing cancel fails safely when the server skips a step", async () => {
    // No confirmation to send back: nothing is changed, exit 1.
    h.tools.cancel_billing = () => ({
      result: {
        ...site,
        status: "confirmation_required",
        currentPeriodEnd: null,
      },
    });
    expect(await h.run("--json", "billing", "cancel", "--yes")).toBe(1);
    expect(h.calls.filter((c) => c.name === "cancel_billing")).toHaveLength(1);
    // The second answer isn't a cancellation: unknown outcome, exit 8.
    h.tools.cancel_billing = () => ({
      result: {
        ...site,
        status: "confirmation_required",
        currentPeriodEnd: null,
        confirmation: "c",
      },
    });
    expect(await h.run("--json", "billing", "cancel", "--yes")).toBe(8);
  });

  it("never asks for the token when the change couldn't be confirmed anyway", async () => {
    h.setInteractive(false);
    h.tools.connect_integration = () => ({ result: {} });
    expect(
      await h.run(
        "--json",
        "integrations",
        "connect",
        "--platform",
        "meta",
        "--pixel",
        "1234567890",
      ),
    ).toBe(2);
    expect(h.secretAsked()).toBe(0);
  });

  it("a saved site from another organization is reported as such", async () => {
    h.tools.get_dns_records = () => ({ result: {} });
    h.tools.list_sites = (args) => ({
      result: {
        orgId: String(args.orgId),
        sites: args.orgId === "org_0000000001" ? [SITES[0]] : [SITES[1]],
        truncated: false,
      },
    });
    expect(await h.run("--json", "sites", "use", "clinic.com")).toBe(0);
    expect(
      await h.run("--json", "dns", "records", "--org", "org_0000000002"),
    ).toBe(2);
    expect(h.json().error.message).toContain("different organization");
    expect(
      await h.run(
        "--json",
        "dns",
        "records",
        "--org",
        "org_0000000002",
        "--site",
        "w1",
      ),
    ).toBe(4);
  });

  it("sites add with --org doesn't change the saved defaults", async () => {
    h.tools.create_site = () => ({
      result: {
        websiteId: "w9",
        orgId: "org_0000000001",
        domain: "n.com",
        status: "created",
        replay: false,
        next: "",
        billingUrl: "",
        integrationsUrl: "",
      },
    });
    expect(
      await h.run(
        "--json",
        "sites",
        "add",
        "n.com",
        "--type",
        "other",
        "--org",
        "org_0000000001",
        "--yes",
      ),
    ).toBe(0);
    expect(h.json().data.defaultChanged).toBe(false);
    expect((await h.profile()).defaultSiteId ?? null).toBeNull();
    expect(
      await h.run(
        "--json",
        "sites",
        "add",
        "n.com",
        "--type",
        "other",
        "--yes",
      ),
    ).toBe(0);
    expect((await h.profile()).defaultSiteId).toBe("w9");
  });
});

describe("review round 3 regressions (Astra r3, Fable r2)", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.init();
    h.tools.get_connection = () => ({
      result: { connected: true, organizations: [ORG], instructions: "" },
    });
    h.tools.list_sites = () => ({
      result: { orgId: "org_0000000001", sites: [SITES[0]], truncated: false },
    });
  });

  it("Ctrl-C during a request exits 130; during a write it also says to check first", async () => {
    const read = new AbortController();
    h.tools.get_install_snippet = () => {
      read.abort();
      return { httpStatus: 500 };
    };
    expect(await h.runWith(read, "--json", "install", "snippet")).toBe(130);
    expect(h.json().error.code).toBe("INTERRUPTED");
    const write = new AbortController();
    h.tools.create_site = () => {
      write.abort();
      return { httpStatus: 500 };
    };
    expect(
      await h.runWith(
        write,
        "--json",
        "sites",
        "add",
        "n.com",
        "--type",
        "other",
        "--yes",
      ),
    ).toBe(130);
    expect(h.json().error.next).toContain("before trying again");
  });

  it("a widened poll after a slow rate-limited first one can't accept an older event", async () => {
    const started = h.now();
    h.tools.check_event = (args) => {
      h.advance(100);
      if (Number(args.sinceMinutes) === 1 && h.now() - started < 1000)
        return {
          error: "Rate limit reached. Retry in one minute.",
          code: "rate_limited",
        };
      // The widened request reaches back to 90 s before the start.
      return {
        result: {
          websiteId: "w1",
          orgId: "org_0000000001",
          event: "Purchase",
          since: new Date(
            h.now() - Number(args.sinceMinutes) * 60_000,
          ).toISOString(),
          checkedAt: new Date(h.now()).toISOString(),
          found: true,
          count: 1,
          partial: false,
          latest: {
            time: new Date(started - 90_000).toISOString(),
            client: "c",
            receivedStatus: "200",
            path: "/",
          },
          note: "",
        },
      };
    };
    expect(
      await h.run(
        "--json",
        "events",
        "verify",
        "--type",
        "purchase",
        "--since",
        "1",
        "--wait",
        "2",
      ),
    ).toBe(6);
  });

  it("a slow answer doesn't move the window back (checkedAt is stamped on arrival)", async () => {
    const started = h.now();
    h.tools.check_event = () => {
      const arrived = h.now();
      h.advance(5_000); // Stape takes 5 s to answer
      return {
        result: {
          websiteId: "w1",
          orgId: "org_0000000001",
          event: "Purchase",
          since: new Date(arrived - 60_000).toISOString(),
          checkedAt: new Date(arrived).toISOString(),
          found: true,
          count: 1,
          partial: false,
          latest: {
            time: new Date(started - 62_000).toISOString(),
            client: "c",
            receivedStatus: "200",
            path: "/",
          },
          note: "",
        },
      };
    };
    expect(
      await h.run(
        "--json",
        "events",
        "verify",
        "--type",
        "purchase",
        "--since",
        "1",
        "--wait",
        "1",
      ),
    ).toBe(6);
  });

  it("next-step commands name the organization", async () => {
    h.tools.get_site_setup = () => ({
      result: {
        websiteId: "w1",
        orgId: "org_0000000001",
        domain: "clinic.com",
        setup: {
          billing: false,
          domainVerified: false,
          scriptsGenerated: false,
          integrationAttached: false,
        },
        billingStatus: "none",
        note: "",
        nextUrls: {},
      },
    });
    expect(
      await h.run(
        "--json",
        "sites",
        "status",
        "--org",
        "org_0000000001",
        "--site",
        "clinic.com",
      ),
    ).toBe(0);
    expect(h.json().data.next.command).toBe(
      "crisper billing link --org org_0000000001 --site clinic.com",
    );
  });

  it("a rate-limited first poll doesn't slide the window forward", async () => {
    const sent: number[] = [];
    h.tools.check_event = (args) => {
      sent.push(Number(args.sinceMinutes));
      if (sent.length === 1)
        return {
          error: "Rate limit reached. Retry in one minute.",
          code: "rate_limited",
        };
      return {
        result: {
          websiteId: "w1",
          orgId: "org_0000000001",
          event: "Purchase",
          since: "s",
          checkedAt: "c",
          found: false,
          count: 0,
          partial: false,
          latest: null,
          note: "",
        },
      };
    };
    expect(
      await h.run(
        "--json",
        "events",
        "verify",
        "--type",
        "purchase",
        "--since",
        "1",
        "--wait",
        "2",
      ),
    ).toBe(6);
    expect(sent[0]).toBe(1);
    expect(sent[1]).toBe(2);
    expect(h.err.join("\n")).toContain("Trying again");
  });
});

describe("agent approval and local validation", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.init();
    h.tools.get_connection = () => ({ result: { organizations: [ORG] } });
    h.tools.list_sites = () => ({
      result: { sites: [SITES[0]], truncated: false },
    });
    h.tools.cancel_billing = () => ({
      result: {
        status: "confirmation_required",
        confirmation: "server-confirmation",
        plan: "Recovery",
        currentPeriodEnd: "2026-11-28",
      },
    });
  });

  const writes = [
    [
      "sites",
      "add",
      "example.com",
      "--type",
      "shopify",
      "--timezone",
      "Europe/London",
    ],
    ["billing", "cancel", "--site", "clinic.com"],
    [
      "integrations",
      "connect",
      "--platform",
      "meta",
      "--pixel",
      "1234567890",
      "--label",
      "Shop's US pixel",
      "--token-stdin",
    ],
  ];
  it.each(writes)(
    "returns a reviewable JSON proposal for %s %s even with a TTY",
    async (...argv) => {
      h.setInteractive(true);
      h.answers.push("yes");
      h.setStdin("a-secret-that-must-not-be-read");
      expect(await h.run(...argv, "--json")).toBe(2);
      const env = h.json();
      expect(env.error).toMatchObject({
        code: "CONFIRMATION_REQUIRED",
        message: "This change needs approval. Nothing was changed.",
        next: "Show the changes to the person, then run the confirmCommand.",
      });
      expect(env.data.changes).toHaveLength(1);
      expect(env.data.changes[0]).toContain(
        argv[0] === "sites" ? "example.com" : "clinic.com",
      );
      if (argv[0] === "sites") {
        expect(env.data.changes[0]).toContain("org_0000000001");
        expect(env.data.changes[0]).toContain(
          "shopify, USD, Europe/London, restricted category on",
        );
        expect(env.data.changes[0]).toContain("No charge");
      }
      if (argv[0] === "billing")
        expect(env.data.changes[0]).toContain("2026-11-28, then stops");
      if (argv[0] === "integrations")
        expect(env.data.changes[0]).toContain("every site using it");
      expect(env.data.confirmCommand).toMatch(/^crisper .* --json --yes$/);
      expect(h.asked()).toBe(0);
      expect(h.secretAsked()).toBe(0);
      expect(h.stdinReads()).toBe(0);
      expect(
        h.calls.some(
          (c) =>
            c.name === "create_site" ||
            c.name === "connect_integration" ||
            c.args.confirmation,
        ),
      ).toBe(false);
      expect(JSON.stringify(env)).not.toContain("server-confirmation");
      expect(JSON.stringify(env)).not.toContain(
        "a-secret-that-must-not-be-read",
      );
    },
  );

  it.each(writes)(
    "does not prompt without a terminal for %s %s",
    async (...argv) => {
      h.setInteractive(false);
      expect(await h.run(...argv)).toBe(2);
      expect(h.err.join("\n")).toContain(
        "This change needs approval. Nothing was changed.",
      );
      expect(h.err.join("\n")).toContain("After approval: crisper ");
      expect(h.asked()).toBe(0);
      expect(h.secretAsked()).toBe(0);
      expect(h.stdinReads()).toBe(0);
    },
  );

  it("replays the exact quoted invocation and accepts approval", async () => {
    const { execFileSync } = await import("node:child_process");
    const label = "Shop's US pixel $(printf expanded)";
    const argv = [
      "--json",
      "integrations",
      "connect",
      "--platform",
      "meta",
      "--pixel",
      "1234567890",
      "--label",
      label,
      "--token-stdin",
    ];
    expect(await h.run(...argv)).toBe(2);
    const replay = h.json().data.confirmCommand as string;
    const parsed = execFileSync("sh", ["-c", `printf '%s\\0' ${replay}`])
      .toString()
      .split("\0")
      .slice(0, -1);
    expect(parsed).toEqual(["crisper", ...argv, "--yes"]);
    h.setStdin("dummy-platform-token-for-test");
    h.tools.connect_integration = () => ({ result: { status: "connected" } });
    expect(await h.run(...parsed.slice(1))).toBe(0);
    expect(
      h.calls.find((c) => c.name === "connect_integration")?.args.label,
    ).toBe(label);
    expect(h.asked()).toBe(0);
    expect(h.stdinReads()).toBe(1);
  });

  it("accepts a typed yes for a human adding a site", async () => {
    h.tools.create_site = () => ({ result: { websiteId: "new-site" } });
    h.answers.push("yes");
    expect(
      await h.run("sites", "add", "example.com", "--type", "shopify"),
    ).toBe(0);
    expect(h.asked()).toBe(1);
    expect(h.calls.some((c) => c.name === "create_site")).toBe(true);
  });

  it("replays an approved JSON billing cancellation through both server steps", async () => {
    expect(await h.run("billing", "cancel", "--json")).toBe(2);
    const command = h.json().data.confirmCommand as string;
    h.tools.cancel_billing = (args) => ({
      result: args.confirmation
        ? { status: "cancel_requested", currentPeriodEnd: "2026-11-28" }
        : {
            status: "confirmation_required",
            confirmation: "fresh-confirmation",
          },
    });
    expect(await h.run(...command.split(" ").slice(1))).toBe(0);
    expect(
      h.calls
        .filter((c) => c.name === "cancel_billing")
        .map((c) => c.args.confirmation),
    ).toEqual([undefined, "fresh-confirmation"]);
    expect(h.asked()).toBe(0);
  });

  it("puts --yes before the end-of-options marker on replay", async () => {
    expect(
      await h.run(
        "--json",
        "sites",
        "add",
        "--type",
        "shopify",
        "--",
        "example.com",
      ),
    ).toBe(2);
    expect(h.json().data.confirmCommand).toBe(
      "crisper --json sites add --type shopify --yes -- example.com",
    );
  });

  const invalidOrgs = [
    "",
    "org_short",
    "org_" + "a".repeat(65),
    "org_012345678-",
    "org_0123456789\n",
    "org_0123456789_",
    "org_012345678é",
  ];
  it.each(invalidOrgs)(
    "rejects invalid org %j before any request, including refresh",
    async (value) => {
      h.advance(4_000_000);
      for (const argv of [
        ["sites", "list", `--org=${value}`],
        ["orgs", "use", value],
      ]) {
        expect(await h.run(...argv, "--json")).toBe(2);
        expect(h.json().error.code).toBe("INVALID_ARGUMENT");
        expect(h.json().error.next).toContain("crisper orgs list");
        expect(h.requests).toEqual([]);
      }
    },
  );

  const invalidSites = [
    "",
    "a b",
    "a\tb",
    "a\nb",
    "a\u001bb",
    "a\u0085b",
    "a".repeat(254),
  ];
  it.each(invalidSites)(
    "rejects invalid site %j before any request",
    async (value) => {
      h.advance(4_000_000);
      for (const argv of [
        ["dns", "records", `--site=${value}`],
        ["sites", "use", value],
      ]) {
        expect(await h.run(...argv, "--json")).toBe(2);
        expect(h.json().error.code).toBe("INVALID_ARGUMENT");
        expect(h.requests).toEqual([]);
      }
    },
  );

  it.each([
    "localhost",
    "a..com",
    "-a.com",
    "a-.com",
    "a.c_m",
    "a.com:443",
    ".com",
    "a.com.",
    "a b.com",
    "a\u001b.com",
    "a".repeat(64) + ".com",
    "a.".repeat(126) + "aa",
  ])("rejects invalid added domain %j before any request", async (domain) => {
    h.advance(4_000_000);
    expect(
      await h.run(
        "sites",
        "add",
        domain,
        "--type",
        "shopify",
        "--yes",
        "--json",
      ),
    ).toBe(2);
    expect(h.json().error.code).toBe("INVALID_ARGUMENT");
    expect(h.requests).toEqual([]);
  });

  it.each(["org_0123456789", "org_" + "A1".repeat(32)])(
    "accepts valid organization boundaries %s",
    async (org) => {
      expect(await h.run("sites", "list", "--org", org, "--json")).toBe(0);
      expect(h.calls[0]?.args).toEqual({ orgId: org });
    },
  );

  it("sends MCP POSTs but no standalone GET during a tool call", async () => {
    expect(await h.run("orgs", "list", "--json")).toBe(0);
    expect(h.calls.map((c) => c.name)).toEqual(["get_connection"]);
    expect(h.requests.length).toBeGreaterThanOrEqual(3);
    expect(
      h.requests.every(
        (r) => r.url === `${ORIGIN}/api/mcp` && r.method === "POST",
      ),
    ).toBe(true);
  });
});
