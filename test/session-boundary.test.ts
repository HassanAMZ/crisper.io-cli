import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  clearSession,
  hasSession,
  loadSession,
  saveSession,
} from "../src/auth/session.js";
import { ConfigStore, MemoryStore } from "../src/auth/store.js";
import { type CliConfig } from "../src/config.js";

const ORIGIN = "https://crisper.io";
const known: CliConfig = { origin: ORIGIN, clientId: "cid", scope: "s" };

async function folderB(secrets: MemoryStore, config: CliConfig) {
  const dir = await mkdtemp(join(tmpdir(), "crisperio-b-"));
  const d = {
    config,
    secrets,
    configs: new ConfigStore(join(dir, "config.json")),
  };
  const p = await saveSession(d, {
    issuer: "https://clerk.example",
    clientId: "cid",
    resource: `${ORIGIN}/api/mcp`,
    tokenEndpoint: "https://clerk.example/oauth/token",
    revocationEndpoint: "https://clerk.example/oauth/token/revoke",
    tokens: {
      accessToken: "B-at",
      refreshToken: "B-rt",
      expiresAt: 9e15,
      scope: null,
    },
  });
  return { d, slot: p.slot! };
}

async function folderC(
  secrets: MemoryStore,
  config: CliConfig,
  profile: object,
  fetcher?: typeof fetch,
) {
  const dir = await mkdtemp(join(tmpdir(), "crisperio-c-"));
  const file = join(dir, "config.json");
  await writeFile(
    file,
    JSON.stringify({ version: 1, profiles: { [ORIGIN]: profile } }),
  );
  return {
    config,
    secrets,
    configs: new ConfigStore(file),
    ...(fetcher ? { fetcher } : {}),
  };
}

const legacy = (clientId: string, extra: object = {}) => ({
  origin: ORIGIN,
  issuer: "https://clerk.example",
  clientId,
  resource: `${ORIGIN}/api/mcp`,
  tokenEndpoint: "https://clerk.example/oauth/token",
  revocationEndpoint: "https://clerk.example/oauth/token/revoke",
  expiresAt: 0,
  scope: null,
  subject: null,
  email: null,
  defaultOrgId: null,
  signedInAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

describe("saved names come only from a valid client ID and slot (TASK-686 review)", () => {
  it("a client ID with `|` in another folder's file never deletes this folder's tokens", async () => {
    const secrets = new MemoryStore();
    const { slot } = await folderB(secrets, known);
    const c = await folderC(secrets, known, legacy(`cid|${slot}`));
    // exactly what `crisper login` does in folder C (commands/auth.ts:127-132)
    if (await hasSession(c)) {
      try {
        await (await loadSession(c)).signOut();
      } catch {
        await clearSession(c).catch(() => {});
      }
    }
    expect(secrets.names()).toHaveLength(2); // intent: B untouched
  });

  it("a crafted old profile never reads or sends another folder's tokens (no built-in client ID)", async () => {
    const secrets = new MemoryStore();
    const unknown: CliConfig = { origin: ORIGIN, clientId: null, scope: "s" };
    const { slot } = await folderB(secrets, unknown);
    const posted: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      posted.push(`${url} ${String(init?.body)}`);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const c = await folderC(
      secrets,
      unknown,
      legacy(`cid|${slot}`, {
        revocationEndpoint: "https://evil.example/revoke",
      }),
      fetcher,
    );
    await loadSession(c).catch(() => {});
    expect(posted).toEqual([]);
    expect(secrets.names()).toHaveLength(2);
  });

  for (const [label, slot] of [
    ["object", {}],
    ["array", []],
    ["null", null],
    ["number", 7],
    ["empty", ""],
    ["upper", "A".repeat(32)],
  ] as const)
    it(`a slot that is ${label} deletes nothing, drops the profile and asks to sign in`, async () => {
      const secrets = new MemoryStore();
      await folderB(secrets, known);
      const c = await folderC(secrets, known, legacy("cid", { slot }));
      const err = await loadSession(c).then(
        () => null,
        (e) => e,
      );
      const left = JSON.parse(await readFile(c.configs.file, "utf8")).profiles;
      expect((err as { code?: string }).code).toBe("AUTH_REQUIRED");
      expect(secrets.names()).toHaveLength(2);
      expect(ORIGIN in left).toBe(false);
    });
});
