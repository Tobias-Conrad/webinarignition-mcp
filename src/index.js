#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAll } from "./server.js";
import { engine } from "./lib/engine.js";

// Stdio-Einstieg (lokal/`npm start`). Seit 26.08.2026 gibt es NUR noch das eine Werkzeug
// wi_webinar — dieselbe Registrierung wie der HTTP-Server, damit an keiner Stelle
// Legacy-Werkzeuge (wi_funnel_*, wi_guide, wi_answer_question, …) auftauchen. Ein Werkzeug
// heisst eine Berechtigungsfrage fuer den Gastgeber (Tobias).
const server = new McpServer({ name: "webinarignition-mcp", version: "1.0.6" });
registerAll(server);

async function main() {
  if (!engine.config.consent_granted) {
    console.error("WI-MCP: run `node src/setup.js --consent` first.");
  } else {
    console.error(`WI-MCP ready. API: ${engine.config.api_base} | Client: ${engine.config.client_id}`);
  }
  await server.connect(new StdioServerTransport());
}
main().catch(e => { console.error("Fatal:", e); process.exit(1); });
