import { afterEach, describe, expect, it, vi } from "vitest";

import { commandsFor, viaRunner } from "../src/invocation.js";
import {
  SPINNER_DELAY_MS,
  isConnectFailure,
  retryingFetch,
  spinner,
  timedFetch,
} from "../src/net.js";

function connectError(code: string) {
  return new TypeError("fetch failed", { cause: { code } });
}

describe("retryingFetch", () => {
  const noSleep = async () => {};

  it("retries a connection that was never made, then succeeds", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      if (calls < 3) throw connectError("UND_ERR_CONNECT_TIMEOUT");
      return new Response("ok");
    }) as typeof fetch;
    const res = await retryingFetch(fetcher, noSleep)("https://crisper.io");
    expect(await res.text()).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after three tries", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      throw connectError("ECONNREFUSED");
    }) as typeof fetch;
    await expect(
      retryingFetch(fetcher, noSleep)("https://crisper.io"),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(3);
  });

  it("never retries a failure after connecting, which the server may have acted on", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      throw connectError("ECONNRESET");
    }) as typeof fetch;
    await expect(
      retryingFetch(fetcher, noSleep)("https://crisper.io"),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(isConnectFailure(connectError("UND_ERR_HEADERS_TIMEOUT"))).toBe(
      false,
    );
    expect(isConnectFailure(new Error("fetch failed"))).toBe(false);
  });

  it("stops when the command is interrupted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      controller.abort();
      throw connectError("ENETUNREACH");
    }) as typeof fetch;
    await expect(
      retryingFetch(fetcher, noSleep)("https://crisper.io", {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("spinner", () => {
  afterEach(() => vi.useRealTimers());

  it("shows nothing for a quick answer", async () => {
    const writes: string[] = [];
    const progress = spinner({ write: (t) => writes.push(t) });
    expect(await progress(async () => 42)).toBe(42);
    expect(writes).toEqual([]);
  });

  it("shows while waiting and clears its line afterwards", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const progress = spinner({ write: (t) => writes.push(t) });
    let finish!: () => void;
    const done = progress(() => new Promise<void>((r) => (finish = r)));
    await vi.advanceTimersByTimeAsync(SPINNER_DELAY_MS + 200);
    expect(writes.some((w) => w.includes("Waiting for Crisper"))).toBe(true);
    finish();
    await done;
    expect(writes.at(-1)).toBe("\r\u001b[2K");
  });
});

describe("suggested commands", () => {
  it("knows when npx or pnpm dlx started it", () => {
    expect(
      viaRunner(
        "/opt/npm-cache/_npx/1a2b/node_modules/crisperio/dist/x.js",
        {},
      ),
    ).toBe(true);
    expect(
      viaRunner("/opt/pnpm-cache/dlx/9f/node_modules/crisperio/dist/x.js", {}),
    ).toBe(true);
    expect(
      viaRunner("/usr/local/lib/node_modules/crisperio/dist/x.js", {}),
    ).toBe(false);
    expect(viaRunner("/x.js", { npm_command: "exec" })).toBe(true);
  });

  it("rewrites commands, not the product name or the domain", () => {
    const rewrite = commandsFor(true);
    expect(rewrite("Pick one: crisper orgs use <orgId>")).toBe(
      "Pick one: npx crisperio orgs use <orgId>",
    );
    expect(rewrite("Run `crisper login`.")).toBe("Run `npx crisperio login`.");
    expect(rewrite('{"command":"crisper billing link"}')).toBe(
      '{"command":"npx crisperio billing link"}',
    );
    expect(rewrite("Signed in to Crisper (crisper.io).")).toBe(
      "Signed in to Crisper (crisper.io).",
    );
    expect(commandsFor(false)("crisper orgs list")).toBe("crisper orgs list");
  });
});

describe("timedFetch", () => {
  it("prints the method, host, path, MCP tool and milliseconds, never the query or token", async () => {
    const lines: string[] = [];
    let t = 0;
    const fetcher = (async () => {
      t += 412;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const timed = timedFetch(fetcher, { write: (s) => lines.push(s) }, () => t);
    await timed("https://crisper.io/api/mcp?code=SECRET", {
      method: "POST",
      headers: { authorization: "Bearer TOKEN" },
      body: JSON.stringify({
        method: "tools/call",
        params: { name: "get_connection", arguments: { x: "SECRET" } },
      }),
    });
    expect(lines).toEqual([
      "[timing] POST crisper.io/api/mcp tools/call get_connection → 200 in 412 ms\n",
    ]);
  });

  it("times a failed connection and names the reason", async () => {
    const lines: string[] = [];
    let t = 0;
    const fetcher = (async () => {
      t += 10_003;
      throw connectError("UND_ERR_CONNECT_TIMEOUT");
    }) as typeof fetch;
    const timed = timedFetch(fetcher, { write: (s) => lines.push(s) }, () => t);
    await expect(timed("https://crisper.io/x")).rejects.toThrow();
    expect(lines[0]).toBe(
      "[timing] GET crisper.io/x → failed after 10003 ms (UND_ERR_CONNECT_TIMEOUT)\n",
    );
  });
});
