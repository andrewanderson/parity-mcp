import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createParityApiSource } from "./data/api.js";
import { createParityServer } from "./server.js";

/**
 * Runtime entry point: wire the real HTTP-backed data source to the parity
 * MCP server and serve it over stdio. Configuration comes from the
 * environment, matching how this project is registered as an MCP server:
 *
 * - `PARITY_API_URL`: base URL of the parity API. Defaults to the temporary
 *   public worker used so far.
 * - `PARITY_DATA_DIR`: directory for automatically persisted canonical games.
 *   Defaults to the workspace data directory.
 */
const DEFAULT_PARITY_API_URL = "https://parity.kevinhughes27.workers.dev";
const DEFAULT_PARITY_DATA_DIR = "D:\\Code\\parity-data";

function main(): Promise<void> {
  const source = createParityApiSource({
    baseUrl: process.env.PARITY_API_URL ?? DEFAULT_PARITY_API_URL,
  });
  const server = createParityServer({
    source,
    dataDir: process.env.PARITY_DATA_DIR ?? DEFAULT_PARITY_DATA_DIR,
  });
  // Log to stderr only: stdout is the MCP stdio channel.
  process.stderr.write(
    `parity-mcp serving over stdio (api=${process.env.PARITY_API_URL ?? DEFAULT_PARITY_API_URL})\n`,
  );
  // The stdio transport keeps the process alive while its parent's pipe is
  // open; closing stdin ends the session.
  return server.connect(new StdioServerTransport()).then(() => undefined);
}

main().catch((cause) => {
  process.stderr.write(`parity-mcp failed to start: ${String(cause)}\n`);
  process.exitCode = 1;
});
