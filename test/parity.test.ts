import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import { loadSession } from "../src/auth/session.js";
import { ConfigStore, KeyringStore } from "../src/auth/store.js";
import { createProgram } from "../src/cli.js";
import { commandCatalog, leafCommands } from "../src/command-tree.js";
import { resolveConfig } from "../src/config.js";
import { COMMAND_TOOLS, COVERED_TOOLS } from "../src/tool-map.js";

/**
 * MCP and CLI parity: every Crisper MCP tool has a CLI command, and every
 * command names only tools that exist.
 *
 * The offline part runs everywhere. The live part reads the tool list from
 * the real server with this computer's `crisper login` and runs when
 * CRISPER_PARITY_LIVE=1 (`pnpm run test:parity`); it is part of the release
 * steps, because tools/list needs a signed-in account and CI has none.
 * The server's own repository also checks this map against its code before
 * every release.
 */
describe("MCP/CLI parity", () => {
  const { program } = createProgram();
  const leaves = leafCommands(program).map(({ command }) => command);

  it("every command is in the tool map, and the map names no missing command", () => {
    expect(Object.keys(COMMAND_TOOLS).sort()).toEqual([...leaves].sort());
  });

  it("commands --json publishes each command's MCP tools", () => {
    for (const c of commandCatalog(program).commands)
      expect(c.mcpTools).toEqual(COMMAND_TOOLS[c.command]);
  });

  it("an equivalent tool (listed after the first) belongs to one command", () => {
    const equivalents = Object.values(COMMAND_TOOLS).flatMap((t) => t.slice(1));
    expect(new Set(equivalents).size).toBe(equivalents.length);
    const primaries = new Set(Object.values(COMMAND_TOOLS).map((t) => t[0]));
    for (const tool of equivalents) expect(primaries.has(tool)).toBe(false);
  });

  it.runIf(process.env.CRISPER_PARITY_LIVE === "1")(
    "the live server's tools and the CLI's commands match",
    { timeout: 60_000 },
    async () => {
      const config = resolveConfig();
      const session = await loadSession({
        config,
        secrets: new KeyringStore(),
        configs: new ConfigStore(),
      });
      const client = new Client({ name: "crisperio-parity", version: "0" });
      const endpoint = new URL(`${config.origin}/api/mcp`);
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          headers: { authorization: `Bearer ${await session.accessToken()}` },
        },
        // Crisper has no standalone SSE stream; skip the SDK's GET.
        fetch: async (input, init) =>
          (init?.method ?? "GET") === "GET"
            ? new Response(null, { status: 405 })
            : fetch(input, init),
      });
      await client.connect(transport);
      try {
        const live = (await client.listTools()).tools.map((t) => t.name);
        const covered = new Set(COVERED_TOOLS);
        expect(
          live.filter((tool) => !covered.has(tool)),
          "MCP tools with no CLI command",
        ).toEqual([]);
        expect(
          COVERED_TOOLS.filter((tool) => !live.includes(tool)),
          "CLI commands pointing to tools the server doesn't have",
        ).toEqual([]);
      } finally {
        await transport.close();
      }
    },
  );
});
