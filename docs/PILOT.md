# 100-customer pilot playbook

## Goal
Validate that Prospex finds usable, verified B2B leads and that AI-personalized outreach gets replies, at zero infrastructure cost, before charging.

## Limits per pilot org (packages/db/src/plans.ts → `pilot`)
1,000 leads, 300 searches, 2,000 verifications, 1,000 AI messages, 1,500 emails per month, 5 campaigns, 3 seats. Every number is enforced in `usage` and returns HTTP 402 `quota_exceeded` when hit. Change with the admin endpoint without redeploying.

Shared-resource budget for 100 orgs on free tiers:
- Search: Google CSE 3,000 + SerpAPI 100 ≈ 3,000-3,500 queries/month total (Brave no longer has a free tier as of Feb 2026, so it's not counted here unless you add it as a paid key). If uptake is high, lower `searchesPerMonth` or add a paid search key.
- AI: Groq free covers ~400k requests/month; not a constraint.
- Email via platform Resend: 3,000/month total → encourage customers to connect their own SMTP (Campaigns → Sender accounts). Per-customer senders are unlimited from your side.
- Postgres: 1,000 leads × 100 orgs ≈ 100k lead rows ≈ 150 MB. Fits Neon's (or Supabase's) free tier comfortably.

## Onboarding flow (what a pilot user does)
1. Sign up (optionally with `PILOT_INVITE_CODE`). They get a JWT session and an API key.
2. Settings → Workspace: name, company, value proposition (used by AI drafts).
3. Ideal customers → New ICP: describe best customers or paste 3-5 customer domains. AI builds criteria.
4. Find leads: natural-language query → 25 leads with emails in 1-2 minutes.
5. Campaigns → Sender accounts: connect Resend/SMTP. New campaign: 3-step sequence (defaults provided), enroll by ICP score ≥ 60, Start.
6. Watch Overview: sent / open / reply rates. Replies auto-stop sequences.

## What to measure (all available from the API)
- `GET /v1/analytics/overview` per org: leads, verified %, sent, open %, reply %.
- `GET /v1/admin/orgs`: activation (orgs with ≥1 search, ≥1 campaign started).
- Email find rate: leads with `emailStatus in (valid, catch_all)` ÷ leads with a company domain. Target ≥ 50% with SMTP, ≥ 35% without.
- Reply rate target for AI-personalized step 1: 3-8% on verified emails.
- Time to first lead: signup → first `search.completed` event (events table).

## Known constraints to tell pilot users
- Discovery depends on search APIs. With only keyless engines from a datacenter IP, results are sparse; with a Google CSE key they are consistent. Company-domain-scoped searches ("people at razorpay.com") are the most reliable.
- Email `valid` requires SMTP port 25 (a paid Fly.io instance or a VPS - Fly no longer has a free tier). On Render/Vercel expect `risky` = MX-checked + pattern-inferred, which still delivers well for `{first}.{last}` companies.
- LinkedIn data comes from public search snippets only; no scraping of LinkedIn itself.
- Deliverability is the customer's domain reputation: warm up, keep daily limits ≤ 50 per sender, always keep the unsubscribe footer on.

## Pricing after pilot (already in plans.ts + Stripe checkout)
Free/Pilot: web-discovery leads only (no paid-provider credits, so they cost nothing to run). Paid tiers add a capped sub-quota of paid-provider (Apollo/Hunter/PDL) leads on top: Starter $99 (1,500 leads, 150 provider-sourced) · Growth $329 (6,000 leads, 500 provider-sourced) · Scale $1,099 (20,000 leads, 1,500 provider-sourced) · Enterprise $2,999 (60,000 leads, 5,000 provider-sourced, usually custom-quoted). All run >=80% gross margin against real provider costs - full math in [PRICING.md](PRICING.md). Set `STRIPE_*` env vars (one `STRIPE_PRICE_<PLAN>` per tier) and `PILOT_MODE=false` to switch signups to the free plan with upgrade buttons.

## Integrating with Cortex
Settings → CRM integrations → Cortex: paste a Cortex ingest URL. Every synced lead POSTs `{source:"prospex", lead, company}`. For the reverse direction, Cortex workflows call `POST /v1/agent/prospect` or use the MCP server; webhooks (`lead.created`, `lead.replied`, ...) push events back with HMAC signatures.
