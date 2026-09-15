# Architecture

```
                ┌──────────────────────────────────────────────────────────┐
  Dashboard ───▶│  apps/api  (Hono)                                        │
  SDK       ───▶│  /v1/auth /v1/search /v1/leads /v1/icps /v1/campaigns    │
  MCP       ───▶│  /v1/agent /v1/integrations /v1/webhooks /t/* tracking   │
  Agents    ───▶│  auth (JWT | API key) · rate limit · quotas · OpenAPI    │
                └───────────────┬──────────────────────┬───────────────────┘
                                │ enqueue              │ direct (sync endpoints)
                        ┌───────▼────────┐     ┌───────▼────────────────────────────┐
                        │ jobs (Postgres │     │ packages/core                       │
                        │ SKIP LOCKED)   │────▶│ search → discovery → crawl →        │
                        │ worker loop or │     │ email find/verify → ICP score →     │
                        │ inline drain   │     │ AI outreach                         │
                        └───────┬────────┘     └───────┬────────────────────────────┘
                                │                      │ providers (all optional, auto-fallback)
                        ┌───────▼────────┐     Google CSE · SerpAPI · Brave · DDG · Bing
                        │ Postgres       │     Groq · Gemini · Anthropic · OpenAI-compat
                        │ orgs users     │     Hunter · Abstract · Resend · SMTP
                        │ leads companies│
                        │ icps campaigns │
                        │ messages events│
                        │ usage webhooks │
                        └────────────────┘
```

## Design decisions

- **No Redis.** The job queue is a Postgres table claimed with `FOR UPDATE SKIP LOCKED`, with retries, exponential backoff, stale-lock reaping, progress, and a serverless `drainJobs()` mode. One fewer paid service and one fewer thing to break.
- **Provider abstraction everywhere.** Search, AI, verification, and email sending each have a small interface with an ordered fallback chain. The platform works with zero keys (degraded) and gets better as free keys are added.
- **Engine has no database dependency.** `packages/core` is pure functions over fetch/dns/net. It can be embedded in Cortex, a CLI, or a Lambda without the API.
- **Idempotent lead upserts** keyed on (org, email) then (org, linkedin). Re-running a search merges rather than duplicates; a verified email is never downgraded by a later unknown.
- **Quotas as data.** Plan limits live on the org row (`plan_limits` JSON) with defaults from `plans.ts`, metered in a `usage` table per month. Admin can override per org without deploys.
- **Tracking without third parties.** Open pixel, click redirect, and unsubscribe are first-party routes under `/t/*` keyed by a random token per message.
- **Secrets at rest** (customer SMTP/CRM credentials) are AES-256-GCM encrypted with `ENCRYPTION_KEY`.
- **Agent-first surface.** `/v1/agent/prospect` collapses the whole pipeline into one JSON call; OpenAPI + MCP expose the same primitives to tool-calling models.

## Job types
`search.run` · `lead.enrich` · `lead.verify` · `leads.bulk_enrich` · `icp.build` · `campaign.tick` (every 60s) · `message.send` · `webhook.deliver` · `integration.sync` · `system.cleanup` · `visit.identify` · `company.enrich` · `signals.subscription` · `signals.scan` (every 6h) · `monitor.run` · `monitors.tick` (every 30m) · `autopilot.run` · `autopilots.tick` (hourly; also fires saved-search alerts at 02:00 UTC) · `savedsearch.run`.

## Events (webhooks)
`org.created` `lead.created` `lead.updated` `lead.enriched` `lead.verified` `lead.replied` `lead.unsubscribed` `lead.status_changed` `leads.imported` `search.completed` `campaign.started` `message.sent` `message.opened` `message.clicked` `task.created` `task.completed` `visitor.identified` `signals.matched` `monitor.results` `monitor.hiring_up` `autopilot.ran` `webhook.test`.

## Extending
- New search provider: implement `SearchProvider` in `packages/core/src/search/providers.ts`, add to `defaultProviders()`.
- New CRM: add a function to `apps/api/src/services/integrations.ts` `providers` map.
- New job: add a handler to `apps/api/src/jobs.ts`; enqueue with `enqueue(db, type, payload, { orgId })`.
- New AI provider: implement `AiProvider` in `packages/core/src/ai/provider.ts`.
