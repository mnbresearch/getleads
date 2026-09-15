# Prospex - Compiled Deployment Guide

This is the single document you need. Part A lists exactly what to give me (or paste into the env). Part B is the deploy procedure. Part C is the feature map so you know what each key unlocks.

**Decision made: production path.** Paid plans (Starter/Growth/Scale/Enterprise) go live for real signups, on free-tier infrastructure and free-tier data-provider keys - no Apollo Professional / Hunter Growth prepayment. `render.yaml` is already configured for this (`PILOT_MODE=false`, `DEFAULT_PLAN=free`, Stripe env vars wired). The one item this path adds versus a pure pilot is Stripe (A7 below) - without it, paid tiers exist in the dashboard but the "Upgrade" button won't render. Everything else is unchanged: the code already guarantees you can't spend provider budget on a customer's behalf before their Stripe payment clears (checked in `apps/api/src/routes/misc.ts`'s webhook handler), and you top up a real data-provider only once a paying customer's usage needs more than the free-tier pool - see "Bootstrapping without prepaying" in [docs/PRICING.md](docs/PRICING.md).

**One thing that changed since the pilot build:** Brave Search API killed its free tier in February 2026 - it's now metered from the first query above a $5/month credit. Google Programmable Search (100 free queries/day) is now the primary free search key; Brave is a small paid line item ($5-15/month) even on the pilot path.

---

## Part A - What you need to provide

Create these accounts and send me the values (or fill `.env` yourself). Items marked REQUIRED are the minimum for a working deployment. Everything else unlocks a feature and is optional; the platform degrades gracefully without it. Each key in A3/A4 is tagged **[Free tier]** or **[Paid tier]** - for the production path, use the paid-tier column.

### A1. Infrastructure (REQUIRED) - one decisive pick per row, chosen for generous free limits + a clean upgrade path, not the cheapest option that breaks later

| # | What | Sign up at | Why this one | Send me |
|---|---|---|---|---|
| 1 | Postgres database | **neon.tech** → New project (free, 0.5GB, autoscaling branch-per-env) → Dashboard → Connection Details → pick the **pooled connection** string | Neon's free compute suspends when idle but never deletes data or breaks the app - reconnects automatically on the next request. Supabase's free tier instead pauses the *entire project* (including auth) after 7 days idle and needs a manual dashboard click to restore, which is a bad look mid-demo. Upgrading later (Neon Launch, ~$19/mo) is a plan change, not a migration. | `DATABASE_URL` |
| 2 | API + worker hosting | **render.com** → New → Web Service (free tier) → connect the GitHub repo. Sign up with GitHub | Free web services get 750 instance-hours/month (enough for one always-on service) and sleep after 15 min with no traffic (~1 min cold start on wake) - fully solved with a free uptime pinger (step B3 below), so it behaves like an always-on service at $0. Fly.io no longer has a free tier for new accounts as of 2026 (legacy-only), so it's not a genuinely free option anymore - worth revisiting once you're paying anyway and want real SMTP verification (see A4/A5 note). | Confirm the repo is on GitHub; I can deploy from this session |
| 3 | Dashboard hosting | **vercel.com** (free, generous static/SPA hosting, painless custom domains). Sign up with GitHub | Free tier has no practical limit for a dashboard's traffic level; upgrading is a billing toggle, not a migration | Confirm account exists (I have a Vercel connector in this session and can deploy it) |
| 4 | GitHub repo | Create an empty private repo, e.g. `mnb-research/prospex` | - | Repo URL + push access, or I hand you the zip to push |
| 5 | A domain (optional but recommended) | e.g. `prospex.mnbresearch.com` for the app, `api.prospex.mnbresearch.com` for the API | - | Domain + DNS access (Cloudflare recommended) |

### A2. AI (REQUIRED for personalization, ICP building, query parsing; at least one)

| # | Provider | Free tier | Where | Send |
|---|---|---|---|---|
| 6 | Groq (recommended, fast) | ~14k requests/day, Llama 3.3 70B | console.groq.com → API Keys | `GROQ_API_KEY` |
| 7 | Google Gemini (fallback) | 1,500 requests/day | aistudio.google.com → Get API key | `GEMINI_API_KEY` |
| 8 | Anthropic (best quality, paid) | pay-as-you-go | console.anthropic.com | `ANTHROPIC_API_KEY` (optional) |

### A3. Lead discovery search (REQUIRED for reliable prospecting; at least one)

Without a key the platform falls back to keyless DuckDuckGo/Bing scraping, which is bot-gated from cloud IPs and returns sparse results.

| # | Provider | Tier | Cost | Where | Send |
|---|---|---|---|---|---|
| 9 | Google Programmable Search (recommended free) | **[Free tier]** | 100 queries/day free | 1) programmablesearchengine.google.com → Add → "Search the entire web" ON → copy **Search engine ID** 2) console.cloud.google.com → APIs → Custom Search JSON API → Enable → Credentials → API key | `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX` |
| 9b | Brave Search API | **[Paid tier]** | No free tier since Feb 2026 - $5/1,000 queries, $5/mo minimum credit | brave.com/search/api → add billing card | `BRAVE_SEARCH_API_KEY` |
| 10 | SerpAPI (optional third, free) | **[Free tier]** | 100 searches/month free | serpapi.com | `SERPAPI_KEY` |

### A4. Data providers (database-quality results, used before web search)

| # | Provider | Tier | Cost | Where | Send |
|---|---|---|---|---|---|
| 11 | Apollo.io free | **[Free tier]** | free plan credits (people search + enrich, small volume) | app.apollo.io → Settings → Integrations → API | `APOLLO_API_KEY` |
| 11b | Apollo.io Professional | **[Paid tier]** | $79/user/mo, 2,000 export credits (~$0.04/lead) - see docs/PRICING.md | same, upgrade plan first | `APOLLO_API_KEY` |
| 12 | Hunter.io free | **[Free tier]** | 25 domain searches + 50 verifications/month | hunter.io → API | `HUNTER_API_KEY` |
| 12b | Hunter.io Growth (annual) | **[Paid tier]** | $104/mo annual, 10,000 credits (~$0.01/verification) | same, upgrade plan first | `HUNTER_API_KEY` |
| 13 | People Data Labs | **[Free tier]** | 100 person enrichments/month free; paid tiers scale per-record | peopledatalabs.com | `PDL_API_KEY` |
| 14 | Abstract email validation | **[Free tier]** | 100/month free | abstractapi.com → Email Validation | `ABSTRACT_EMAIL_API_KEY` |
| 15 | ipinfo.io | **[Free tier]** | 50k IP lookups/month free (visitor identification; keyless ipapi.is is default) | ipinfo.io → token | `IPINFO_TOKEN` |

For the production path, only Apollo and Hunter need the paid tier to start - PDL/Abstract/ipinfo free tiers are generous enough to stay free even at moderate volume. Full cost-per-lead math and recommended customer pricing tiers: [docs/PRICING.md](docs/PRICING.md).

### A5. Email sending (REQUIRED for campaigns; one platform-wide, customers can add their own)

| # | Provider | Free tier | Where | Send |
|---|---|---|---|---|
| 17 | Resend (recommended) | 3,000 emails/month, 100/day | resend.com → API Keys; Domains → add + verify your sending domain (DNS records) | `RESEND_API_KEY`, `MAIL_FROM` (e.g. `Prospex <hello@prospex.mnbresearch.com>`) |
| 18 | Brevo SMTP (alternative) | 300 emails/day | brevo.com → SMTP & API | `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS` |

Inbound replies (so sequences stop on reply): in Resend → Webhooks, or via Zapier/Make Gmail trigger, POST `{from, subject, text}` to `https://<api>/v1/campaigns/inbound` with the customer's API key.

### A6. Channels (OPTIONAL)

| # | Provider | Free tier | Where | Send |
|---|---|---|---|---|
| 19 | WhatsApp Cloud API | 1,000 service conversations/month | developers.facebook.com → Create app → WhatsApp → API setup → Phone number ID + permanent token; create and get approval for a template with one `{{1}}` body variable | Configured per customer in Settings → Integrations → WhatsApp (phoneNumberId, accessToken, templateName) |

### A7. Billing - REQUIRED for the production path (this is what makes paid signups actually work)

Without Stripe configured, the dashboard still shows all plans but no "Upgrade" button renders - so this is the one item that turns "free demo" into "customers can actually pay you." No data-provider spend is needed to set this up; it only touches Stripe and your own database.

1. dashboard.stripe.com → Product catalog → New product, four times, each with one **recurring monthly** price:
   - "Prospex Starter" - $99.00/month
   - "Prospex Growth" - $329.00/month
   - "Prospex Scale" - $1,099.00/month
   - "Prospex Enterprise" - $2,999.00/month (usually custom-quoted in practice, but a real Stripe price still needs to exist for the checkout button to work)
2. Copy each price's ID (starts `price_...`) into `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_SCALE`, `STRIPE_PRICE_ENTERPRISE` respectively - these map 1:1 to the plan ids already in `packages/db/src/plans.ts`, no code change needed if the names match exactly.
3. Developers → API keys → copy the **secret key** → `STRIPE_SECRET_KEY`.
4. Developers → Webhooks → Add endpoint → `https://<your-api>/v1/billing/webhook` → select events `checkout.session.completed` and `customer.subscription.deleted` → copy the **signing secret** → `STRIPE_WEBHOOK_SECRET`.
5. Send me all six values: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_SCALE`, `STRIPE_PRICE_ENTERPRISE`.

You can start in Stripe **test mode** (test-mode keys, e.g. `sk_test_...`) to verify the whole checkout → webhook → plan-upgrade flow end to end before flipping to live keys - costs nothing and catches config mistakes before a real customer hits them.

### A8. Secrets I generate for you (no action needed)

`JWT_SECRET`, `ENCRYPTION_KEY`, `INTERNAL_TOKEN` - I'll generate 32-byte random values at deploy time. Keep `INTERNAL_TOKEN`; it is your admin key for `/v1/admin/*`.

### A9. Pilot policy decisions (tell me)

- Invite-only signup? If yes, choose an invite code → `PILOT_INVITE_CODE`.
- Default plan for new signups: `pilot` (1,000 leads/mo, 300 searches, 2,000 verifications, 1,000 AI messages, 1,500 emails, 5 campaigns, 3 seats) or something else. Adjustable later per org via admin API without redeploy.
- Region for the API: Render's Singapore region is closest to India for lowest latency.

**Minimum to go live on the production path today: items 1, 2, 3, 4, 6, 9, 17, and A7 (Stripe).** Items 11/12/13 (free-tier data providers) are worth adding too since they feed the premium-lead sub-quota on paid plans, but aren't blocking - the platform runs on web-discovery leads alone without them. You don't need 11b/12b (paid Apollo/Hunter subscriptions) at all to start; add a paid data-provider key only once real customer volume needs it, bought as pay-as-you-go credits rather than a subscription until volume is consistent - see docs/PRICING.md.

---

## Part B - Deploy procedure

### B1. Push the code
```bash
unzip prospex.zip && cd prospex
git init && git add -A && git commit -m "Prospex v2"
git remote add origin git@github.com:<you>/prospex.git && git push -u origin main
```

### B2. Database
Paste the Neon pooled connection string into `DATABASE_URL`. Migrations run automatically on API boot (`AUTO_MIGRATE=true` by default). Two migrations: `0001_init.sql`, `0002_v2.sql`. (Using Supabase instead works identically - just note its free project pauses after 7 days idle and needs a manual unpause click.)

### B3. API + worker

**Option 1 - Render (recommended, simplest genuinely-free option).** Dashboard → New → Blueprint → pick the repo; `render.yaml` is detected. Set the `sync: false` env vars from Part A. The single web service runs the API and the embedded worker (`EMBED_WORKER=true`). Add the health URL `https://<service>.onrender.com/health` to a free uptime monitor (UptimeRobot / cron-job.org, every 10 min) so the free instance does not sleep and the scheduler keeps running. Render blocks port 25: keep `SMTP_PROBE_ENABLED=false` (emails verify as `risky` = MX + pattern; add Hunter/Abstract keys for `valid`).

**Option 2 - Vercel serverless (API too).** Works, but background jobs need `JOB_MODE=inline` plus an external cron hitting `GET https://<api>/internal/jobs/run?token=<INTERNAL_TOKEN>` every minute (cron-job.org). Prefer Render for the worker unless you specifically want everything on Vercel.

**Once you're paying anyway and want real SMTP-verified emails** (not the free-tier MX+pattern `risky` check): Fly.io no longer has a free tier for new accounts (pay-as-you-go from the first machine, roughly $2-3/month for a small instance), but it's worth it at that point specifically because it allows outbound port 25 on request, which Render blocks entirely.
```bash
fly launch --no-deploy --copy-config
fly secrets set DATABASE_URL=... JWT_SECRET=$(openssl rand -hex 32) ENCRYPTION_KEY=$(openssl rand -hex 32) INTERNAL_TOKEN=$(openssl rand -hex 24) \
  GROQ_API_KEY=... GOOGLE_CSE_API_KEY=... GOOGLE_CSE_CX=... RESEND_API_KEY=... MAIL_FROM="Prospex <hello@yourdomain>" \
  APP_URL=https://prospex.vercel.app API_URL=https://prospex-api.fly.dev SMTP_PROBE_ENABLED=true
fly deploy
```
Then open a support ticket: "please unblock outbound port 25 for app prospex-api (email verification, no bulk sending)". Until approved, set `SMTP_PROBE_ENABLED=false`.

Verify: `curl https://<api>/health` → `{"ok":true,"db":"up"}`; open `https://<api>/docs`.

### B4. Dashboard (Vercel)
Import the repo → Root directory `apps/web` → Framework Vite → Env `VITE_API_URL=https://<api>`. `apps/web/vercel.json` handles SPA routing. Then set `APP_URL` on the API to the Vercel URL (CORS + links in emails).

### B5. Domains (optional)
CNAME `prospex.<yourdomain>` → Vercel; `api.prospex.<yourdomain>` → Render. Update `APP_URL`, `API_URL`, `VITE_API_URL`. The visitor pixel and tracking links use `API_URL`, so set it before customers install pixels.

### B6. Post-deploy checks (5 minutes)
1. Sign up at the dashboard → you get an API key. On the production path this lands you on the `free` plan (1 seat, 50 leads) like any real customer would - bump your own test org up first so the rest of this checklist isn't blocked by free-tier limits: `curl -X POST https://<api>/v1/admin/orgs/<orgId>/plan -H "x-internal-token: $INTERNAL_TOKEN" -H 'content-type: application/json' -d '{"plan":"growth"}'`.
2. Settings → Team → invite a colleague (email arrives if Resend/SMTP is set).
3. Find leads → "Founders of fintech startups in Bengaluru" → 25 results in 1-2 min (needs the Google CSE key).
4. Website visitors → New website → paste the snippet on mnbresearch.com → visit /pricing from an office IP → company appears within ~10s.
5. Intent signals → Scan now → live funding/acquisition/leadership news parsed → Find decision makers.
6. Tools → Sender domain health → your sending domain → fix anything below 90 before campaigns.
7. Campaigns → add sender → 3-step sequence (LinkedIn connect → email A/B → WhatsApp or email) → enroll → start.
8. Run `API=https://<api> ./scripts/smoke.sh && ./scripts/smoke-v2.sh` for the full 40-check regression.
9. Settings → Billing → click "Upgrade" on Starter with Stripe in **test mode** first → complete test checkout (card `4242 4242 4242 4242`, any future date/CVC) → confirm the org's plan flips to `starter` and the premium-leads quota shows 150 in Settings → Usage. Only then switch Stripe to live keys.

### B7. Operating
- Admin: `GET /v1/admin/orgs`, `POST /v1/admin/orgs/:id/plan {plan, overrides}` with header `x-internal-token`.
- Free-tier budget for 100 orgs: Google CSE 3k queries/month (100/day) + SerpAPI 100/month ≈ 3,000-3,500 searches/month total, no Brave spend if you skip 9b. If usage is high, lower `searchesPerMonth` in `packages/db/src/plans.ts` (pilot) or add Brave/Apollo paid keys.
- Scaling past free: Neon Launch ~$19/mo (removes the idle-suspend behavior entirely), Render Starter $7 (always-on, no cold start), Google CSE $5/1k queries past the free 100/day. No code changes needed for infra scaling. For scaling the *business* (paid customers, not just infra), see docs/PRICING.md for provider-tier upgrades and plan restructuring - the pilot plan limits in `plans.ts` are not safe to sell at paid-provider cost. Optionally split the worker into its own process (`npm run start:worker`, set `EMBED_WORKER=false` on the web service).
- Logs: Render dashboard. Job failures live in the `jobs` table with `error` and retry with backoff.

---

## Part C - What each key unlocks (feature map)

| Feature | Works with zero keys? | Better with |
|---|---|---|
| Natural-language lead search (LinkedIn profiles via search engines) | Sparse (bot-gated) | Google CSE / SerpAPI / Brave, Apollo |
| Company enrichment (website crawl: description, team, emails, tech, socials) | Yes | - |
| Company intelligence (hiring by function, news, intent score) | Yes | - |
| Email finding (pattern inference + candidates) | Yes | Hunter, Apollo, PDL |
| Email verification | MX-only (`risky`) on Render/Vercel; full SMTP (`valid`) once deployed somewhere with port 25 open (Fly.io paid, or a VPS) | Hunter, Abstract |
| ICP scoring (rules) | Yes | - |
| ICP lookalike builder, AI email personalization, reply intent, query parsing | No (template fallback) | Groq / Gemini / Anthropic |
| Website visitor identification (pixel, ISP filtering, intent by page, decision makers) | Yes (ipapi.is keyless) | ipinfo token, Google CSE for decision makers |
| Intent signals (funding, acquisition, hiring, leadership, expansion, launch, partnership) from news, subscriptions that auto-create leads | Yes (Google News RSS) | Google CSE for decision makers |
| Monitors: LinkedIn post engagers, competitor, keyword, company news, job openings | Yes (LinkedIn posts only when publicly served) | - |
| LinkedIn URL → email, email → LinkedIn, colleagues, decision makers by persona | Partial | Brave/Google, Apollo, PDL |
| Sequences: email A/B variants, LinkedIn connect/message tasks, call tasks, WhatsApp, send windows, daily limits, open/click/reply tracking, unsubscribe, auto-stop | Email needs a sender | Resend / SMTP; WhatsApp Cloud API |
| Engagement scoring + lead pipeline status (new → contacted → engaged → replied → qualified → customer) | Yes | - |
| Autopilot (daily autonomous prospecting → list → campaign) | Needs search key | Brave/Google + AI |
| Saved searches with daily email alerts | Needs search key + mail | - |
| Team seats + invites | Yes (invite link shown; email needs mail provider) | Resend |
| Domain deliverability check (SPF/DKIM/DMARC/MX) | Yes | - |
| Webhooks (HMAC), CRM sync (HubSpot, Pipedrive, Zoho, Cortex, generic, Sheets) | Yes | customer's CRM tokens |
| REST API + OpenAPI + SDK + MCP (46 tools) | Yes | - |
| Stripe billing | Off in pilot | Stripe keys |
