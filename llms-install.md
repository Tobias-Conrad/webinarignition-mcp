# Installation guide for agents

WebinarIgnition is a **remote** MCP server. There is nothing to build, clone or install —
you connect to a hosted endpoint over Streamable HTTP.

## Add the server

```json
{
  "mcpServers": {
    "webinarignition": {
      "type": "streamable-http",
      "url": "https://mcp.webinarignition.com/?src=github"
    }
  }
}
```

- No API key, no sign-in, no environment variables.
- Protocol: Streamable HTTP, MCP `2025-06-18` (JSON-RPC 2.0).
- Health check: `GET https://mcp.webinarignition.com/health`

## Verify it works

1. `initialize` — expect `serverInfo.name = "WebinarIgnition"`.
2. `tools/list` — expect `wi_webinar` and `wi_webinar_delete`.
3. Call `wi_webinar` with `was="start"` — the user sees tappable options.

## Tools

| Tool | Purpose | Kind |
|---|---|---|
| `wi_webinar` | Plan, write and set up a webinar; also answers product questions. Step is selected with `was`. | write |
| `wi_webinar_delete` | Delete or replace something on the connected WordPress site. | destructive |

Prompts: `build_my_webinar`, and more.
Resources: `webinarignition://interfaces`, `webinarignition://capabilities`, `webinarignition://how-it-works`.

## Local (stdio) alternative

The same tool surface is implemented in this repository for stdio clients:

```
npm install
npm start
```

This is optional — the hosted endpoint above is the supported way to use the server.

## Notes

- The connector works with no WordPress site. Connecting a WordPress site that runs
  WebinarIgnition is optional and unlocks 71 site tools.
- Nothing changes on a site without an explicit OK.
- Website: https://webinarignition.com
