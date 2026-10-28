import { describe, expect, it } from "vitest";

import {
  normalizeOrigin,
  requireClientId,
  resolveConfig,
} from "../src/config.js";
import { CliError, EXIT, sanitize } from "../src/errors.js";
import { type Writer, emit, envelope, safeText, table } from "../src/output.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const writer: Writer = { out: (s) => out.push(s), err: (s) => err.push(s) };
  return { out, err, writer };
}

describe("envelope and emit", () => {
  it("writes exactly one JSON object to stdout on success and on failure", () => {
    const ok = capture();
    emit(
      { json: true, color: false },
      envelope(
        "orgs list",
        { origin: "https://crisper.io" },
        { ok: true, data: { organizations: [] } },
        () => new Date(0),
      ),
      () => "human",
      ok.writer,
    );
    expect(ok.out).toHaveLength(1);
    expect(ok.err).toHaveLength(0);
    expect(JSON.parse(ok.out[0]!)).toEqual({
      schemaVersion: 1,
      command: "orgs list",
      ok: true,
      context: { origin: "https://crisper.io" },
      data: { organizations: [] },
      error: null,
      meta: { observedAt: "1970-01-01T00:00:00.000Z", requestId: null },
    });

    const failed = capture();
    const error = new CliError("AUTH_REQUIRED", "You are not signed in.", {
      exit: EXIT.auth,
      next: "Run `crisper login`.",
    });
    emit(
      { json: true, color: false },
      envelope(
        "orgs list",
        { origin: "https://crisper.io" },
        { ok: false, error },
        () => new Date(0),
      ),
      () => "human",
      failed.writer,
    );
    expect(failed.out).toHaveLength(1);
    const parsed = JSON.parse(failed.out[0]!);
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error).toEqual({
      code: "AUTH_REQUIRED",
      message: "You are not signed in.",
      retryable: false,
      next: "Run `crisper login`.",
      retryAfterSeconds: null,
    });
  });

  it("sends human errors to stderr, never stdout", () => {
    const c = capture();
    const error = new CliError("RATE_LIMITED", "Too many requests right now.", {
      exit: EXIT.rateLimited,
      next: "Wait.",
    });
    emit(
      { json: false, color: false },
      envelope("x", { origin: "o" }, { ok: false, error }),
      () => "",
      c.writer,
    );
    expect(c.out).toHaveLength(0);
    expect(c.err[0]).toBe("Too many requests right now.\nWait.");
  });

  it("escapes control characters in server strings", () => {
    expect(safeText("Clinic\u001b[2J\u0007 name")).toBe(
      "Clinic\\x1b[2J\\x07 name",
    );
    expect(
      table([
        ["A", "B"],
        ["x\u001b", "yy"],
      ]),
    ).toBe("A      B\nx\\x1b  yy");
  });

  it("sanitizes unknown errors to a generic failure", () => {
    const e = sanitize(new Error("ECONNRESET at 10.0.0.1 token=abc"));
    expect(e.code).toBe("SERVER_ERROR");
    expect(e.exit).toBe(1);
    expect(e.message).not.toContain("abc");
  });
});

describe("config", () => {
  it("defaults to crisper.io with no client until production sign-in exists", () => {
    const c = resolveConfig({});
    expect(c.origin).toBe("https://crisper.io");
    expect(c.clientId).toBeNull();
    expect(() => requireClientId(c)).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_UNAVAILABLE", exit: 7 }),
    );
  });

  it("accepts env overrides and refuses insecure origins", () => {
    expect(
      resolveConfig({
        CRISPER_ORIGIN: "http://localhost:3010/",
        CRISPER_OAUTH_CLIENT_ID: "dev",
      }),
    ).toEqual({
      origin: "http://localhost:3010",
      clientId: "dev",
      scope: "profile email offline_access",
    });
    expect(() => normalizeOrigin("http://crisper.io")).toThrowError(
      expect.objectContaining({ exit: 2 }),
    );
    expect(() => normalizeOrigin("nope")).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });
});
