# Prospex

Open, zero-cost B2B lead generation infrastructure for sales teams and AI agents.

Real-time discovery from the open web and LinkedIn, company enrichment, work-email finding and verification, AI lookalike ICP scoring, AI-personalized sequences with tracking, webhooks, CRM sync, a REST API, a TypeScript SDK, an MCP server and a dashboard. Runs entirely on free tiers for a ~100-customer pilot.

```
apps/
  api/        Hono REST API + Postgres job worker (Node 20+). Deploys to Render / Fly / Docker / Vercel.
  web/        React + Vite + Tailwind dashboard. Deploys to Vercel / Netlify / Cloudflare Pages.
packages/
  core/       The engine: search providers, discovery, crawler, email find/verify, ICP scoring, AI outreach. No DB deps.
  db/         Drizzle schema, SQL migrations, Postgres-backed job queue (no Redis), usage metering, plans.
  sdk/        Zero-dependency TypeScript client.
  mcp/        MCP server: 46 tools for Claude Desktop / Claude Code / Cursor / Cortex agents.
docs/         Deployment, pilot playbook, architecture.
scripts/      smoke.sh + smoke-v2.sh - end-to-end API tests.
```

## 60-second local start

```bash
cp .env.example .env            # only DATABASE_URL + JWT_SECRET are required
docker compose up -d db         # or point DATABASE_URL at Supabase/Neon
npm install
npm run db:migrate && npm run db:seed   # prints demo login + API key
npm run dev:api                  # http://localhost:8080  (docs at /docs), worker embedded in dev
npm run dev:web                  # http://localhost:5173
```

Login: `demo@prospex.local` / `demo1234`.

## What is built

| Layer | What it does | Free provider(s) |
|---|---|---|
| Discovery | `site:linkedin.com/in` + company queries across search engines with automatic fallback | Google CSE (100/day free), SerpAPI (100/mo free), Brave ($5/1k, no free tier since Feb 2026), DuckDuckGo + Bing HTML (keyless) |
| Enrichment | Crawls company sites: description, JSON-LD, team pages, public emails, tech stack, socials | built-in |
| Email finding | Pattern inference from known emails, 12 candidate patterns, web search for published addresses | built-in, Hunter (25/mo) optional |
| Verification | Syntax, disposable, role, MX, SMTP handshake, catch-all detection, auto-detect blocked port 25 | built-in, Hunter / Abstract (100/mo) optional |
| ICP scoring | Token-based title match with synonyms, seniority/department inference, weighted rules 0-100 with reasons; AI lookalike profile from description + seed customer domains; AI re-rank | Groq (free), Gemini (free), Anthropic, any OpenAI-compatible |
| Outreach | Sequences with delays, send window, per-account daily limits, AI-personalized copy per step, open/click tracking, unsubscribe + suppression, reply ingestion + intent classification, auto-stop | Resend (3k/mo), any SMTP (Brevo 300/day) |
| Platform | Multi-tenant orgs, JWT + API keys, plan quotas with monthly metering, rate limiting, event log, HMAC webhooks, CRM sync (HubSpot, Pipedrive, Zoho, Cortex, generic webhook, Sheets), Stripe (optional) | Supabase / Neon Postgres |
| Website visitors | Cookieless pixel, reverse-IP company identification with ISP/hosting filtering, page-level intent scoring, one-click decision makers | ipapi.is (keyless), ipinfo (50k/mo) |
| Intent signals | Funding, acquisition, hiring, leadership, expansion, launch, partnership signals from news; subscriptions auto-create decision-maker leads and enroll them | Google News RSS (keyless) |
| Monitors | LinkedIn post engagers → leads, competitor mentions, keywords, company news, job-opening tracking | keyless |
| Data providers | Apollo / Hunter / PDL results merged ahead of web discovery when keys are set | free tiers |
| Multichannel | Sequence steps for email (A/B variants), LinkedIn connect/message (tasks), calls, WhatsApp Cloud API; engagement scoring; pipeline statuses | Meta WhatsApp (1k conv/mo) |
| Autopilot | Autonomous daily prospecting: query → enrich → verify → score → list → campaign | - |
| Tools | LinkedIn↔email, colleagues, decision makers by persona, company intel, bulk verify, domain health (SPF/DKIM/DMARC), saved searches + alerts, team invites | - |
| Agents | `POST /v1/agent/prospect` one-call workflow, OpenAPI 3.1 at `/openapi.json`, Swagger at `/docs`, SDK, MCP server (46 tools) | - |

## Deploy for free

See [DEPLOY.md](DEPLOY.md) - the compiled guide listing every account/key to provide and the exact procedure. Longer notes in [docs/DEPLOY.md](docs/DEPLOY.md). Summary: Neon (DB) + Render (API + worker) + Vercel (dashboard) + Groq (AI) + Google Programmable Search (search) + Resend (email). Total: $0/month for the pilot.

## Pilot playbook

See [docs/PILOT.md](docs/PILOT.md) for the 100-customer pilot plan, limits, and what to measure.

## API in 3 calls

```bash
# 1. sign up (returns JWT + API key)
curl -X POST $API/v1/auth/signup -H 'content-type: application/json' \
  -d '{"email":"you@co.com","password":"********","orgName":"Your Co"}'

# 2. one-call prospecting for agents
curl -X POST $API/v1/agent/prospect -H "x-api-key: px_live_..." -H 'content-type: application/json' \
  -d '{"query":"Heads of Sales at fintech startups in Bengaluru","limit":5,"generateEmails":true,
       "sender":{"name":"Mridul","company":"MNB Research","valueProp":"AI automation for SMEs"}}'

# 3. verify any email
curl -X POST $API/v1/search/verify -H "x-api-key: px_live_..." -H 'content-type: application/json' \
  -d '{"email":"someone@company.com"}'
```

## MCP for Claude / Cursor

```json
{ "mcpServers": { "prospex": { "command": "npx", "args": ["-y", "@prospex/mcp"],
  "env": { "PROSPEX_API_KEY": "px_live_...", "PROSPEX_API_URL": "https://your-api.onrender.com" } } } }
```

## Tests

```bash
npm test -w packages/core        # unit tests (parsers, patterns, scoring, templates)
API=http://localhost:8080 ./scripts/smoke.sh      # 15-step end-to-end API test (v1)
API=http://localhost:8080 ./scripts/smoke-v2.sh   # visitors, signals, monitors, tools, tasks, team, autopilot, multichannel A/B
```

## License

MIT for the code. You are responsible for complying with the terms of the search engines, LinkedIn, and email providers you route through, and with anti-spam law (CAN-SPAM, GDPR, India's IT Act) when sending outreach.
