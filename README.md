# WebinarIgnition MCP Server

[![MCP Badge](https://lobehub.com/badge/mcp/tobias-conrad-webinarignition-mcp)](https://lobehub.com/mcp/tobias-conrad-webinarignition-mcp)

Build and run WordPress webinars from a chat. One MCP server that puts WebinarIgnition
inside any AI assistant — Claude, ChatGPT, Cursor and any MCP-capable client.

- **Endpoint:** `https://mcp.webinarignition.com/?src=registry`
- **Transport:** Streamable HTTP, MCP protocol 2025-06-18 (JSON-RPC 2.0)
- **Auth:** none. No sign-in, no API key, no install.
- **Website:** https://webinarignition.com

> **About this repository.** This is the public source mirror of the hosted
> WebinarIgnition MCP server (`https://mcp.webinarignition.com`). Two internal
> modules are intentionally **not** part of the mirror — the live-pricing reader
> and the product knowledge service — so the supported way to use the server is
> the hosted endpoint above. Everything else (MCP transport, funnel session
> engine, WordPress connection flow, outbound channel) is included.

## Install

Remote MCP server (Streamable HTTP, no auth): `https://mcp.webinarignition.com/?src=registry`.
Agents: see [llms-install.md](llms-install.md) for the exact steps.

## Tools

mcp.so and other directories read this section. Listed below is what the connector
exposes, and beneath it what the connected WordPress site offers.

### Connector tools (always available)

| Tool | What it does | Kind |
|---|---|---|
| `wi_webinar` | Plan, write and set up a webinar from a chat: topic, title, invitation emails, reminders, registration page, live room, evergreen funnel. Also answers product questions. Selects the step with `was`. | write |
| `wi_webinar_delete` | Delete or replace something on the connected WordPress site. Irreversible. | destructive |

`wi_webinar` is a single entry point with guided steps (`was`): `start` (entry),
`thema` (topic), `weiter` (continue), `texte` (write the texts), `seite` (build the page),
`verbinden` (connect a WordPress site), `faehigkeiten` (what the site can do),
`ausfuehren` (run a site ability), `fragen` (product questions), `alles`, `ready`.

### Site tools (offered by the connected WordPress site)

Once a WordPress site is connected, the connector exposes **71 tools** across 11 areas.
They are read live from the site, so the list always matches the installed version.

| Area | Count | Examples |
|---|---|---|
| webinar | 15 | `wi_list_webinars`, `wi_get_webinar`, `wi_create_webinar`, `wi_funnel_stats`, `wi_run_preflight` |
| config | 14 | `wi_configure_webinar`, `wi_woo_offer_in_room`, `wi_configure_100ms`, `wi_configure_daily`, `wi_write_invite_texts` |
| control | 10 | `wi_master_switch`, `wi_room_switch`, `wi_list_questions`, `wi_answer_question`, `wi_get_prompter` |
| gutenberg | 6 | `wi_reg_page_blocks`, `wi_reg_page_edit`, `wi_media_search`, `wi_repair_registration_pages` |
| mail | 6 | `wi_get_emails`, `wi_check_mail`, `wi_send_test_email`, `wi_resend_renotifications` |
| webhook | 6 | `wi_list_webhooks`, `wi_upsert_webhook`, `wi_send_test_webhook`, `wi_read_webhook_history` |
| leads | 5 | `wi_list_leads`, `wi_export_leads`, `wi_import_leads_csv` |
| colors | 3 | `wi_get_colors`, `wi_update_colors`, `wi_sample_brand_colors` |
| autoresponder | 2 | `wi_set_autoresponder`, `wi_test_autoresponder` |
| settings | 2 | `wi_list_settings`, `wi_list_step_types` |
| report | 2 | `wi_list_report_types`, `wi_get_reports` |

### What the tools do to your site

Every site tool is labelled, so an assistant — and you — can tell them apart before
anything runs:

- **28 read-only** — lists, checks and reports. Nothing is touched.
  (`wi_list_webinars`, `wi_get_webinar`, `wi_funnel_stats`, `wi_check_mail`, `wi_run_preflight`, …)
- **35 change something** — creating, editing, publishing, sending. Each one is confirmed first.
  (`wi_create_webinar`, `wi_configure_webinar`, `wi_set_autoresponder`, `wi_master_switch`, `wi_woo_offer_in_room`, …)
- **8 delete or reset** — irreversible.
  (`wi_delete_campaign`, `wi_delete_lead`, `wi_delete_all_leads`, `wi_reset_funnel`, `wi_delete_logs`, `wi_delete_webhook`, `wi_delete_all_questions`, `wi_import_hc_campaign`)

**Nothing changes on your site without your OK.** A tool in the `control` scope requires
explicit confirmation; the host may grant it once when connecting, otherwise it is asked
on every call. Every write is snapshotted and audited.

## Architecture

```
AI client (Claude / ChatGPT / Cursor / …)
    │
    └── WebinarIgnition MCP Server   https://mcp.webinarignition.com
            │
            ├── writes and reads webinars (connector, no site needed)
            │
            └── connected WordPress site → the real webinar, on your own hosting
```

Two doors exist by design, and both are optional:

1. **Connector only** — plan the webinar, write the title, invitation emails and reminders,
   produce the registration copy. Works with no WordPress at all.
2. **Connected site** — connect a WordPress site that runs WebinarIgnition, and the assistant
   builds the real thing: registration page, live room, evergreen schedule, WooCommerce
   offer in the room.

## Connecting

Add the URL in your assistant's MCP settings:

```
https://mcp.webinarignition.com/?src=registry
```

In Claude: **Settings → Connectors → Add custom connector**, paste the URL, leave everything
else as it is, save. Then open a new chat and write: *"Build me a webinar for freelancers."*

Works the same in Cursor, Claude Code, ChatGPT and any other assistant that speaks MCP.

The WordPress side is connected from inside the plugin (**WebinarIgnition → AI connection**),
which returns a link the host opens in the browser to approve. No inbound access to the
WordPress site is required — it polls the connector, so it also works behind a firewall
or on shared hosting.

## Sources

Directories list their own endpoint URL with an attribution parameter:

| Source | URL |
|---|---|
| MCP Registry | `https://mcp.webinarignition.com/?src=registry` |
| Smithery | `https://mcp.webinarignition.com/?src=smithery` |
| mcp.so | `https://mcp.webinarignition.com/?src=mcpso` |
| Glama | `https://mcp.webinarignition.com/?src=glama` |
| mcpbeat | `https://mcp.webinarignition.com/?src=mcpbeat` |
| ChatGPT app | `https://mcp.webinarignition.com/?src=chatgpt` |
| Claude connector | `https://mcp.webinarignition.com/?src=claude` |

## Health

- `GET /health` — service status
- `GET /.well-known/mcp/server-card.json` — published capability card
- `GET /openapi.json` — HTTP schema

## Links

- Plugin on WordPress.org: https://wordpress.org/plugins/webinar-ignition/
- Product site: https://webinarignition.com
- AI Webinar Writer (no install): https://webinarignition.com/ai-webinar-writer/
- Agent & API guide: https://webinarignition.com/llms.txt
