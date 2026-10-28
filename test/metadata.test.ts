import { describe, expect, it } from "vitest";

import { discoverAuth } from "../src/auth/metadata.js";

const issuer = "https://clerk.example";
const prm = {
  resource: "https://crisper.io/api/mcp",
  authorization_servers: [issuer],
  scopes_supported: ["profile", "email"],
};
const as = {
  issuer,
  device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
  token_endpoint: `${issuer}/oauth/token`,
  revocation_endpoint: `${issuer}/oauth/token/revoke`,
  grant_types_supported: [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code",
  ],
};

function fetcherFor(docs: Record<string, unknown>) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const doc = docs[url];
    if (doc === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(doc), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("discoverAuth", () => {
  it("reads resource and endpoints from the two metadata documents", async () => {
    const meta = await discoverAuth(
      "https://crisper.io",
      fetcherFor({
        "https://crisper.io/.well-known/oauth-protected-resource/api/mcp": prm,
        [`${issuer}/.well-known/oauth-authorization-server`]: as,
      }),
    );
    expect(meta).toEqual({
      resource: "https://crisper.io/api/mcp",
      issuer,
      deviceAuthorizationEndpoint: `${issuer}/oauth/device_authorization`,
      tokenEndpoint: `${issuer}/oauth/token`,
      revocationEndpoint: `${issuer}/oauth/token/revoke`,
      scopesSupported: ["profile", "email"],
    });
  });

  it("rejects an issuer that doesn't match the advertised authorization server", async () => {
    await expect(
      discoverAuth(
        "https://crisper.io",
        fetcherFor({
          "https://crisper.io/.well-known/oauth-protected-resource/api/mcp":
            prm,
          [`${issuer}/.well-known/oauth-authorization-server`]: {
            ...as,
            issuer: "https://evil.example",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "METADATA_INVALID" });
  });

  it("rejects endpoints that leave the issuer's origin", async () => {
    await expect(
      discoverAuth(
        "https://crisper.io",
        fetcherFor({
          "https://crisper.io/.well-known/oauth-protected-resource/api/mcp":
            prm,
          [`${issuer}/.well-known/oauth-authorization-server`]: {
            ...as,
            token_endpoint: "https://evil.example/token",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "METADATA_INVALID" });
  });

  it("rejects an issuer without the device grant", async () => {
    await expect(
      discoverAuth(
        "https://crisper.io",
        fetcherFor({
          "https://crisper.io/.well-known/oauth-protected-resource/api/mcp":
            prm,
          [`${issuer}/.well-known/oauth-authorization-server`]: {
            ...as,
            grant_types_supported: ["authorization_code"],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "METADATA_INVALID", exit: 7 });
  });

  it("reports an unreachable origin as a network error", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      discoverAuth("https://crisper.io", failing),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});
