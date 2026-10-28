import { describe, expect, it } from "vitest";

import { pollForToken, requestDeviceCode } from "../src/auth/device.js";
import { CliError } from "../src/errors.js";

type Reply = { status: number; body: unknown } | Error;

function fakeFetch(
  replies: Reply[],
  calls: { url: string; body: string }[] = [],
) {
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    const reply = replies.shift();
    if (!reply) throw new Error("no reply queued");
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const start = {
  deviceCode: "dev-secret",
  userCode: "ABCD-EFGH",
  verificationUri: "https://issuer.example/device",
  verificationUriComplete: null,
  expiresIn: 600,
  interval: 5,
};

const pollArgs = {
  tokenEndpoint: "https://issuer.example/oauth/token",
  clientId: "cid",
  resource: "https://crisper.io/api/mcp",
  start,
};

function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("requestDeviceCode", () => {
  it("sends client_id, scope and resource and returns the user-facing code", async () => {
    const { fetcher, calls } = fakeFetch([
      {
        status: 200,
        body: {
          device_code: "dev-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://issuer.example/device",
          verification_uri_complete:
            "https://issuer.example/device?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 5,
        },
      },
    ]);
    const result = await requestDeviceCode(
      {
        endpoint: "https://issuer.example/oauth/device_authorization",
        clientId: "cid",
        scope: "profile email offline_access",
        resource: "https://crisper.io/api/mcp",
      },
      { fetcher },
    );
    const sent = new URLSearchParams(calls[0]!.body);
    expect(sent.get("client_id")).toBe("cid");
    expect(sent.get("resource")).toBe("https://crisper.io/api/mcp");
    expect(sent.get("scope")).toBe("profile email offline_access");
    expect(sent.has("client_secret")).toBe(false);
    expect(result.userCode).toBe("ABCD-EFGH");
    expect(result.verificationUriComplete).toContain("ABCD-EFGH");
  });

  it("maps a client that isn't enabled to CAPABILITY_UNAVAILABLE", async () => {
    const { fetcher } = fakeFetch([
      { status: 400, body: { error: "invalid_client" } },
    ]);
    await expect(
      requestDeviceCode(
        {
          endpoint: "https://issuer.example/d",
          clientId: "x",
          scope: "profile",
          resource: "r",
        },
        { fetcher },
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE", exit: 7 });
  });
});

describe("pollForToken", () => {
  it("waits through pending and slow_down, then returns tokens with the resource on every poll", async () => {
    const c = clock();
    const { fetcher, calls } = fakeFetch([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 400, body: { error: "authorization_pending" } },
      {
        status: 200,
        body: {
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          scope: "profile email",
        },
      },
    ]);
    const tokens = await pollForToken(pollArgs, {
      fetcher,
      sleep: c.sleep,
      now: c.now,
    });
    expect(tokens).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: c.now() + 3600 * 1000,
      scope: "profile email",
    });
    // 5 s, 5 s, then 10 s after slow_down, then 10 s.
    expect(c.sleeps).toEqual([5000, 5000, 10000, 10000]);
    for (const call of calls) {
      const sent = new URLSearchParams(call.body);
      expect(sent.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:device_code",
      );
      expect(sent.get("device_code")).toBe("dev-secret");
      expect(sent.get("resource")).toBe("https://crisper.io/api/mcp");
      expect(sent.has("client_secret")).toBe(false);
    }
  });

  it("stops on access_denied with exit 3", async () => {
    const c = clock();
    const { fetcher, calls } = fakeFetch([
      { status: 400, body: { error: "access_denied" } },
    ]);
    await expect(
      pollForToken(pollArgs, { fetcher, sleep: c.sleep, now: c.now }),
    ).rejects.toMatchObject({
      code: "AUTH_DENIED",
      exit: 3,
    });
    expect(calls).toHaveLength(1);
  });

  it("stops on expired_token and at the local deadline", async () => {
    const c = clock();
    const { fetcher } = fakeFetch([
      { status: 400, body: { error: "expired_token" } },
    ]);
    await expect(
      pollForToken(pollArgs, { fetcher, sleep: c.sleep, now: c.now }),
    ).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
    // The code expires while we sleep: no further poll is sent.
    const late = clock();
    const never = fakeFetch([]);
    await expect(
      pollForToken(pollArgs, {
        fetcher: never.fetcher,
        sleep: async (ms) => {
          late.advance(ms + 601_000);
        },
        now: late.now,
      }),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED", exit: 3 });
    expect(never.calls).toHaveLength(0);
  });

  it("retries a network failure with backoff while the code is valid", async () => {
    const c = clock();
    const { fetcher } = fakeFetch([
      new Error("socket hang up"),
      { status: 200, body: { access_token: "at", expires_in: 60 } },
    ]);
    const tokens = await pollForToken(pollArgs, {
      fetcher,
      sleep: c.sleep,
      now: c.now,
    });
    expect(tokens.refreshToken).toBeNull();
    expect(c.sleeps).toEqual([5000, 7000]);
  });

  it("stops at once when cancelled", async () => {
    const c = clock();
    const controller = new AbortController();
    controller.abort();
    const { fetcher, calls } = fakeFetch([]);
    await expect(
      pollForToken(
        { ...pollArgs, signal: controller.signal },
        { fetcher, sleep: c.sleep, now: c.now },
      ),
    ).rejects.toMatchObject({ code: "INTERRUPTED", exit: 130 });
    expect(calls).toHaveLength(0);
  });

  it("never exposes the device code in an error", async () => {
    const c = clock();
    const { fetcher } = fakeFetch([
      {
        status: 500,
        body: {
          error: "server_error",
          error_description: "dev-secret leaked?",
        },
      },
    ]);
    try {
      await pollForToken(pollArgs, { fetcher, sleep: c.sleep, now: c.now });
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect(JSON.stringify((error as CliError).toJSON())).not.toContain(
        "dev-secret",
      );
    }
  });
});
