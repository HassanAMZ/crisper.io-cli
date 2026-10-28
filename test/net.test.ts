import { afterEach, describe, expect, it, vi } from "vitest";

import { commandsFor, viaRunner } from "../src/invocation.js";
import {
  SPINNER_DELAY_MS,
  isConnectFailure,
  retryingFetch,
  spinner,
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
