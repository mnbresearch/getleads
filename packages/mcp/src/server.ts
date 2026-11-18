#!/usr/bin/env node
/**
 * Scout MCP server (stdio), for AI assistants such as Claude Desktop and Cursor.
 *
 * The same tools are also served over HTTP by the Scout API at POST /mcp (see
 * apps/api/src/routes/mcp.ts), which needs nothing installed. This stdio build is for
 * running Scout against a private API address.
 *
 * It is NOT published to a public package registry - do not run it with `npx`. Run it from
 * this repository:
 *
 *   npm run build -w packages/mcp
 *
 * and point the assistant at the built file:
 *
 *   { "mcpServers": { "scout": { "command": "node", "args": ["<path-to-repo>/packages/mcp/dist/server.js"],
 *       "env": { "PROSPEX_API_KEY": "<your API key>", "PROSPEX_API_URL": "https://<your Scout API address>" } } } }
 *
 * PROSPEX_API_URL must be https:// (http:// is accepted for localhost only), so the key is
 * never sent unencrypted.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Prospex } from "@prospex/sdk";
import { registerScoutTools } from "./tools.js";

const gl = new Prospex();
const server = new McpServer({ name: "prospex", version: "0.1.0" });
registerScoutTools(server, gl);

const transport = new StdioServerTransport();
await server.connect(transport);
