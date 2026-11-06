# Scout Integration & Telephony Guide

## 1. CRM Integrations

Scout supports bi-directional sync across leading CRM platforms.

### HubSpot
- **Sync Direction**: Bi-directional.
- **Entities**: Contacts, Companies, Deals, Engagements (Call logs, emails).
- **Trigger**: Webhooks on stage changes; automatic call activity creation when disposition is set in Scout AI Dialer.

### Pipedrive & Zoho
- **Deals**: Automatically synced when created or updated in Scout Pipeline (`/v1/deals`).
- **Activities**: Dialer calls logged with duration, recording reference, and rep notes.

---

## 2. Telephony & Voice Architecture

Scout's dialer is designed with a provider-agnostic abstraction layer:

```
[ Scout Frontend Dialer Workspace ]
                 |
          (WebRTC Audio Stream)
                 v
   [ Telephony Gateway Service ]
      /                      \
[ Twilio Voice API ]     [ Exotel / Local Telco ]
```

### Supported Providers
- **Twilio Voice WebRTC**: Default for North America and EMEA outbound calling.
- **Exotel / Local Carrier**: SIP trunking option for APAC and low-latency local dialing.
- **Browser Audio**: Fully browser-based via WebRTC without requiring external softphone software.

---

## 3. Scout Model Context Protocol (MCP) Server

Scout includes an enterprise MCP server (`@prospex/mcp`) allowing AI assistants (Claude, Cursor, Antigravity) to query sales intelligence directly.

### Available MCP Tools
- `get_intent_leads`: Returns high-fit leads based on visitor deanonymization.
- `create_play_step`: Adds touches to an active sequence.
- `list_opportunities`: Retrieves current deal pipeline and risk states.
- `log_call_disposition`: Submits call results programmatically.
