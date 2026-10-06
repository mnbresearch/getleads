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

`JWT_SECRET`, `ENCRYPTION_KEY`, `INTERNAL_TOKEN`, `ADMIN_API_TOKEN` - generated as long random values at deploy time (`render.yaml` does this). What each one is for:

| Variable | What it guards | Notes |
|---|---|---|
| `JWT_SECRET` | Every customer session | At least 32 random characters (`openssl rand -hex 32`); the API warns at startup if it is shorter, and refuses to start in production on the built-in default, on a value published in the example files, or on fewer than 16 characters (section B10). Rotating it signs every user out once. |
| `ENCRYPTION_KEY` | Stored SMTP passwords, CRM tokens, webhook secrets | Set it. Without it those are encrypted under `JWT_SECRET`. To rotate: put the new value in `ENCRYPTION_KEY` and the old one in `ENCRYPTION_KEYS_OLD` (comma-separated, newest first). Reads try every listed key; new writes use `ENCRYPTION_KEY`. Dropping the old value without listing it makes every saved sender and integration unreadable. |
| `INTERNAL_TOKEN` | `/internal/jobs/run` only (the serverless job runner) | Sent in the `x-internal-token` header, never in the URL. It is **not** an admin credential. The Render deployment (embedded worker) does not call this endpoint at all. |
| `ADMIN_API_TOKEN` | Server-to-server calls to `/v1/admin/*` (header `x-admin-token`) | Separate from `INTERNAL_TOKEN`. Leave it unset and the header path is off; the admin dashboard's password login still works. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | The admin dashboard login | Use a long random password. Five wrong attempts from one address lock that address for up to 15 minutes; fifty wrong attempts in 15 minutes lock the form for every address that has not signed in before. An address you have signed in from keeps working either way. "Sign out" in the dashboard revokes the session on the server. |
| `ADMIN_JWT_SECRET` (optional) | Signs the admin dashboard session | Falls back to `JWT_SECRET`. Setting it means a leak of `JWT_SECRET` alone cannot mint an admin session. |
| `ADMIN_TOTP_SECRET` (optional, recommended) | A second factor on the admin dashboard login | A base32 secret that you also add to an authenticator app. When set, signing in to `/admin` needs the current 6-digit code as well as the password. Unset, the login is email + password as before. How to create it: section B9, "Admin two-factor sign-in". |

**If `INTERNAL_TOKEN` was ever put in a URL** (the old cron instructions said `?token=`), treat it as leaked - URLs are written to access logs and cron dashboards - and rotate it: Render → the API service → Environment → `INTERNAL_TOKEN` → generate a new value → save. Nothing else needs to change on Render.

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
Paste the Neon pooled connection string into `DATABASE_URL`. Migrations run automatically on API boot (`AUTO_MIGRATE=true` by default). Every file in `packages/db/migrations` is applied once, in order, and recorded in the `_migrations` table. (Using Supabase instead works identically - just note its free project pauses after 7 days idle and needs a manual unpause click.)

### B3. API + worker

**Option 1 - Render (recommended, simplest genuinely-free option).** Dashboard → New → Blueprint → pick the repo; `render.yaml` is detected. Set the `sync: false` env vars from Part A. The single web service runs the API and the embedded worker (`EMBED_WORKER=true`). Add the health URL `https://<service>.onrender.com/health` to a free uptime monitor (UptimeRobot / cron-job.org, every 10 min) so the free instance does not sleep and the scheduler keeps running. Render blocks port 25: keep `SMTP_PROBE_ENABLED=false` (emails verify as `risky` = MX + pattern; add Hunter/Abstract keys for `valid`).

**Option 2 - Vercel serverless (API too).** Works, but background jobs need `JOB_MODE=inline` plus an external cron hitting `GET https://<api>/internal/jobs/run` every minute (cron-job.org) **with the request header `x-internal-token: <INTERNAL_TOKEN>`** (cron-job.org: edit the job → Advanced → Headers → add key `x-internal-token`). The token is not accepted in the URL (`?token=` answers 403): a secret in a URL ends up in every access log on the way. Also set `TRUSTED_PROXY=xff` there (see B3a). Prefer Render for the worker unless you specifically want everything on Vercel.

**Once you're paying anyway and want real SMTP-verified emails** (not the free-tier MX+pattern `risky` check): Fly.io no longer has a free tier for new accounts (pay-as-you-go from the first machine, roughly $2-3/month for a small instance), but it's worth it at that point specifically because it allows outbound port 25 on request, which Render blocks entirely.
```bash
fly launch --no-deploy --copy-config
fly secrets set DATABASE_URL=... JWT_SECRET=$(openssl rand -hex 32) ENCRYPTION_KEY=$(openssl rand -hex 32) INTERNAL_TOKEN=$(openssl rand -hex 24) ADMIN_API_TOKEN=$(openssl rand -hex 24) TRUSTED_PROXY=xff \
  GROQ_API_KEY=... GOOGLE_CSE_API_KEY=... GOOGLE_CSE_CX=... RESEND_API_KEY=... MAIL_FROM="Prospex <hello@yourdomain>" \
  APP_URL=https://prospex.vercel.app API_URL=https://prospex-api.fly.dev SMTP_PROBE_ENABLED=true
fly deploy
```
Then open a support ticket: "please unblock outbound port 25 for app prospex-api (email verification, no bulk sending)". Until approved, set `SMTP_PROBE_ENABLED=false`.

Verify: `curl https://<api>/health` → `{"ok":true,"db":"up"}`; open `https://<api>/docs`.

### B4. Dashboard (Vercel)
Import the repo → Root directory `apps/web` → Framework Vite → Env `VITE_API_URL=https://<api>`. Optionally `VITE_DEMO_VIDEO_ID=<youtube id>` to show the explainer under the hero; unset, that section is not rendered. `apps/web/vercel.json` handles SPA routing. Then set `APP_URL` on the API to the Vercel URL (CORS + links in emails).

### B3a. Network settings the API needs to know about

- `TRUSTED_PROXY` - which proxy header carries the visitor's real address. Rate limits and the security log use it, so a wrong value either lets one person dodge the limits or puts everyone in one bucket.
  - `cloudflare` - use `cf-connecting-ip`. Correct on Render (its edge is Cloudflare, which overwrites the header) and for any domain proxied through Cloudflare. `render.yaml` sets this.
  - `xff` - use the right-most `X-Forwarded-For` entry. Use on Vercel, Fly and other hosts that are not behind Cloudflare; there `cf-connecting-ip` is whatever the client typed.
  - `none` - nothing in front of the API; headers are ignored.
  - Unset: `cloudflare` on Render, `xff` on any other production host.
- `CORS_EXTRA_ORIGINS` - comma-separated browser origins allowed to call the API in addition to `APP_URL` (e.g. a second dashboard domain). `CORS_ALLOW_REGEX` - a regular expression of further allowed origins; by default any `https://*.vercel.app` origin, so Vercel preview deployments keep working. Set it to `none` to turn that off. The API never allows credentialed (cookie) cross-origin requests.
- Request size limits: 1 MB per request, 10 MB for the lead import, 256 KB for the unauthenticated endpoints (sign-in, pixel, unsubscribe). Larger bodies get `413 payload_too_large`.
- Sign in with Google uses a short-lived cookie on the API's own domain (`g_state`) while the browser is at Google. `API_URL` must be the exact public https URL of the API, and the Google console's redirect URI must be `<API_URL>/v1/auth/google/callback`.

### B5. Domains (optional)
CNAME `prospex.<yourdomain>` → Vercel; `api.prospex.<yourdomain>` → Render. Update `APP_URL`, `API_URL`, `VITE_API_URL`. The visitor pixel and tracking links use `API_URL`, so set it before customers install pixels.

### B6. Post-deploy checks (5 minutes)
1. Sign up at the dashboard → you get an API key. On the production path this lands you on the `free` plan (1 seat, 50 leads) like any real customer would - bump your own test org up first so the rest of this checklist isn't blocked by free-tier limits: `curl -X PATCH https://<api>/v1/admin/orgs/<orgId>/plan -H "x-admin-token: $ADMIN_API_TOKEN" -H 'content-type: application/json' -d '{"plan":"growth"}'` (or use the admin dashboard at `/admin`).
2. Settings → Team → invite a colleague (email arrives if Resend/SMTP is set).
3. Find leads → "Founders of fintech startups in Bengaluru" → 25 results in 1-2 min (needs the Google CSE key).
4. Website visitors → New website → paste the snippet on mnbresearch.com → visit /pricing from an office IP → company appears within ~10s.
5. Intent signals → Scan now → live funding/acquisition/leadership news parsed → Find decision makers.
6. Tools → Sender domain health → your sending domain → fix anything below 90 before campaigns.
7. Campaigns → add sender → 3-step sequence (LinkedIn connect → email A/B → WhatsApp or email) → enroll → start.
8. Run `API=https://<api> ./scripts/smoke.sh && ./scripts/smoke-v2.sh` for the full 40-check regression.
9. Settings → Billing → click "Upgrade" on Starter with Stripe in **test mode** first → complete test checkout (card `4242 4242 4242 4242`, any future date/CVC) → confirm the org's plan flips to `starter` and the premium-leads quota shows 150 in Settings → Usage. Only then switch Stripe to live keys.

### B7. Operating
- Admin: `GET /v1/admin/orgs`, `PATCH /v1/admin/orgs/:id/plan {plan, overrides}` with header `x-admin-token: $ADMIN_API_TOKEN` (not `INTERNAL_TOKEN`, which only runs the job queue). `plan` must be a real plan id; `overrides` is a strict partial of the plan limits (whole numbers from 0, or true/false for the switches) and anything else is refused with a message naming the field. A workspace keeps its overrides when only its plan changes; send `"overrides": {}` to clear them. Every admin change is written to the security log of the workspace it touched (Settings → Security log; table `audit_log`), with the value before and after; a request that changes nothing answers `changed: false` and is not logged. Customers see what the operator changed in their security log, never the address it was changed from.
- Free-tier budget for 100 orgs: Google CSE 3k queries/month (100/day) + SerpAPI 100/month ≈ 3,000-3,500 searches/month total, no Brave spend if you skip 9b. If usage is high, lower `searchesPerMonth` in `packages/db/src/plans.ts` (pilot) or add Brave/Apollo paid keys.
- Scaling past free: Neon Launch ~$19/mo (removes the idle-suspend behavior entirely), Render Starter $7 (always-on, no cold start), Google CSE $5/1k queries past the free 100/day. No code changes needed for infra scaling. For scaling the *business* (paid customers, not just infra), see docs/PRICING.md for provider-tier upgrades and plan restructuring - the pilot plan limits in `plans.ts` are not safe to sell at paid-provider cost. Optionally split the worker into its own process (`npm run start:worker`, set `EMBED_WORKER=false` on the web service).
- Logs: Render dashboard. Job failures live in the `jobs` table with `error` and retry with backoff.

### B8. Deploying this release (admin fixes, Google sign-in, migration 0018)

Do it in this order, in one sitting:

1. **Deploy the API first.** On boot it applies migration `0018_grandfather_existing_users.sql` (unless `AUTO_MIGRATE=false`, in which case run `npm run db:migrate` before starting the new code). Check `curl https://<api>/health` answers `{"ok":true,"db":"up"}`.
2. **Deploy the web app immediately after.** In the minutes between the two, the old web app talking to the new API shows an error when someone clicks "Sign in with Google" and asks them to reload. It never signs anyone in unsafely, and password sign-in is unaffected. Reloading after the web deploy fixes it.
3. **Rotate `INTERNAL_TOKEN`** if it was ever sent as `?token=` in a URL (section A8). On Render nothing calls the job runner, so there is nothing else to update; on a serverless deploy, update the header in the cron service.
4. Sign in to `/admin`, open "Tools & limits" and press "Test all keys". The summary now says how many keys were tested and names any provider that holds a key but cannot be tested for free.

What migration 0018 does:

- **Existing accounts keep everything on their first Google sign-in.** "Sign in with Google" takes over a password account whose address was never proved: the password is turned off, sessions are signed out and, for a single-user workspace, API keys are revoked. Before this release nothing recorded that an address was proved, so every existing password account would have been treated that way. The migration marks every account that exists at deploy time as owning its address, so those accounts are simply linked to Google. Accounts created after the deploy are unproved until a password reset or a Google sign-in proves them, and the takeover rule applies to those.
- Adds the `admin_revoked_tokens` table, which is what makes admin "Sign out" real.
- Adds the Reoon and MillionVerifier rows to "Tools & limits".

It is idempotent and only adds things; it can be re-run safely.

**Rolling back.** (Section B11 has the full, rehearsed procedure; what follows is this release's part of it.) The previous release runs on the upgraded database, so rolling back is "redeploy the previous build" and nothing needs to be undone in the database. Three things made on the new code do not work on the old code, so check them if you roll back:

- **Webhooks created or rotated on the new code** sign with v2 and keep their secret encrypted. The old code cannot read that secret, so those webhooks stop delivering until you roll forward again (webhooks that were never rotated keep working).
- **Sender and integration credentials saved on the new code** are stored in the new encrypted format, which the old code cannot decrypt. Those senders and integrations show as needing to be reconnected on the old code. Do not reconnect them there: run `scripts/rollback-restore.mjs` before rolling back (B11) and the old code reads them, or roll forward and they work again.
- **Job-change signals** cannot be inserted by the old code (it writes against the old index), so the daily job-change scan logs errors and records nothing until you roll forward. Nothing already stored is lost.

Admin sessions issued by the new code keep working on the old code, but the old code ignores sign-outs: a signed-out admin session works again until it expires (12 hours at most). Rotate `ADMIN_JWT_SECRET` (or `JWT_SECRET` if that is not set) if that matters.

Optional settings that this release reads (all have safe defaults, none is required):

| Variable | What it does | Default |
|---|---|---|
| `ADMIN_JWT_SECRET` | Signs the admin session with its own key | falls back to `JWT_SECRET` |
| `ENCRYPTION_KEYS_OLD` | Previous `ENCRYPTION_KEY` values, so rotating the key does not make saved credentials unreadable | none |
| `TRUSTED_PROXY` | Which proxy header carries the visitor's address (`cloudflare`, `xff`, `none`) | `cloudflare` on Render, `xff` elsewhere |
| `CORS_EXTRA_ORIGINS`, `CORS_ALLOW_REGEX` | Extra browser origins allowed to call the API | `APP_URL`, localhost and `https://*.vercel.app` |
| `LEAD_NOTIFY_EMAIL` | Where upgrade requests are emailed | `ADMIN_EMAIL` |
| `OUTBOUND_SENDING_ENABLED` | `false` pauses every campaign send platform-wide; nothing is lost, sends resume when it is `true` again | `true` |
| `ORG_DAILY_SEND_CEILING` | The most one workspace may send per day across all its senders | 2000 |
| `SYSTEM_SENDER_DAILY_CAP` | The most one workspace may send per day through the shared platform sender | 50, or 1/20 of the plan's monthly emails |
| `AUTO_MIGRATE` | `false` stops the API applying migrations on boot (you then run `npm run db:migrate` yourself before each deploy) | `true` |

### B9. Account security in this release (migration 0019)

Migration `0019_account_security.sql` only adds things (nullable columns and new tables), so the previous release keeps running on the upgraded database. Nothing here changes how an existing customer signs in: every protection is either something a person turns on for themselves, or applies to accounts created from now on.

**What customers get**

- **Two-factor sign-in** (Settings > Security). Opt-in per person. After the password, sign-in asks for a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy, Microsoft Authenticator - any app that reads a standard QR code). Ten single-use recovery codes are shown once when it is turned on. Sign in with Google is not asked for the code (Google does its own).
- **Email confirmation for new accounts.** A new signup is emailed a link (valid 24 hours). Until they click it the workspace cannot send team invitations or use the shared platform sender; everything else works. Accounts that existed before this release, and accounts created with Google, are already confirmed.
- **Read-only API keys.** A key can be created as "read-only": it can fetch data and cannot change anything. Existing keys are full access, as before.
- **Security emails.** The account owner is emailed when their password is changed or reset, two-factor sign-in is turned on or off, an API key is created, or the account is signed in to from an address it has not used before.

The confirmation link and the security emails are sent through the platform's own mail provider (`RESEND_API_KEY`, or `SMTP_HOST` and friends - section A5). **With no mail provider configured they are simply not sent, and unconfirmed accounts are not restricted in any way** - a deployment can never lock its users behind an email it cannot send. Set a mail provider to get both.

**When a customer has lost their phone AND their recovery codes**

There is one way back in, and it is yours: Admin > the workspace > the user > "Reset two-factor" (`POST /v1/admin/orgs/:id/users/:userId/reset-2fa`). Their password alone then signs them in and they can set two-factor up again. Before you do it, satisfy yourself that the person asking is the account's owner (reply to the address on the account, not to the address the request came from): the reset removes a protection the owner chose. It is recorded in the workspace's security log and the user is emailed that support did it.

**Admin two-factor sign-in (recommended)**

The admin dashboard guards every customer's plan and status behind one password. Add a second factor:

1. Create a secret - 32 base32 characters (letters A-Z and digits 2-7). Either of:
   ```
   node -e "const a='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';console.log([...require('crypto').randomBytes(32)].map(b=>a[b&31]).join(''))"
   openssl rand 20 | base32
   ```
2. Add it to your authenticator app: "Add account" > "Enter a setup key" (some apps say "Enter key manually"). Account name: `Scout admin`. Key: the secret. Type: time based. (If you prefer to scan a QR code, make one on your own machine from `otpauth://totp/Scout%20admin?secret=<THE SECRET>&issuer=Scout`, for example with `qrencode -t ansiutf8 '<that link>'`. Do not paste the secret into an online QR generator.)
3. Store the secret in your password manager as well. It is the only copy apart from the one on the server, and it is how you add a second phone or replace a lost one.
4. Set it on the server: Render > the API service > Environment > add `ADMIN_TOTP_SECRET` with the secret as its value > save (the service restarts).
5. Sign out of `/admin` and sign in again. After the email and password the form asks for the 6-digit code.

Notes:

- A code works once. If a sign-in fails on the code, wait for the next one (they change every 30 seconds) and check that the phone's clock is set automatically: the codes depend on the time, and one step (30 seconds) either way is tolerated.
- Wrong codes count towards the admin lock exactly like wrong passwords.
- The server-to-server header (`x-admin-token: $ADMIN_API_TOKEN`) is a separate credential and is not asked for a code.
- Lost the phone: add the secret from your password manager to a new phone. Lost the secret too: delete `ADMIN_TOTP_SECRET` (or set a new one) in the Render dashboard; whoever can do that already controls the deployment.
- A value that is not base32 is refused at sign-in with a message saying so, rather than silently ignored; the API also warns about it at startup.

When a mail provider is configured, `ADMIN_EMAIL` is emailed when the admin dashboard is signed in to from an address that has not signed in before, and when the admin login is locked after failed attempts.

**The Security tab in the admin dashboard**

`GET /v1/admin/security/summary` (the last 24 hours: failed sign-ins, locked accounts, refused actions, admin sign-ins, new workspaces, exports, bulk deletions, workspaces waiting to be deleted, the addresses with the most failed sign-ins) and `GET /v1/admin/audit-log` (the security log across every workspace, filterable by workspace, action, result and actor). Both accept the admin session or the `x-admin-token` header.

**Limits that are new**

- New workspaces: 5 an hour and 20 a day from one network address. Past that the signup form says so and asks the person to try later or write to us. (Counted in the API process's memory, like the other rate limits.)
- "Forgot password": one address is mailed at most 3 reset links an hour, whoever asks. The form answers the same either way.

**Rolling back**

Redeploy the previous build; the database needs nothing undone (B11 has the full procedure, including client report links and invitations). On the old code:

- **Read-only API keys become full-access keys.** The old code does not know about key scopes and lets any key write. If you roll back for more than a moment, revoke the read-only keys first (`UPDATE api_keys SET revoked_at = now() WHERE NOT ('*' = ANY(scopes)) AND revoked_at IS NULL;`) or tell the customers who created them.
- **Two-factor sign-in is not asked for.** Accounts that turned it on sign in with their password alone until you roll forward; their setting is kept.
- `ADMIN_TOTP_SECRET` is ignored: the admin login is email + password again.
- Email confirmation is not enforced and security emails are not sent.

---

### B10. Platform hardening in this release (read before deploying)

Nothing here needs a migration. Three things are worth a minute BEFORE the deploy, because they change how the server starts and how it connects to the database.

**1. Database connection security.** The server used to connect with "TLS if the other end offers it", and that setting overrode whatever `sslmode` the connection string asked for. Anyone able to sit between the API and the database could answer "no TLS" and receive the login in clear text. Now the server decides from the database host:

| Database host | What happens | Same as before? |
|---|---|---|
| `localhost`, `127.0.0.1`, `::1` | no TLS | yes |
| a single-label name (`db`, a platform's internal service name), a private-network name (`*.internal`, `*.flycast`, `*.local`, `*.lan` and similar) or a private address | TLS when offered | yes |
| `*.neon.tech` | TLS, **and the server's certificate is checked** (also when the string says `sslmode=require`) | stricter |
| any other remote host | TLS required - the connection fails rather than fall back to plaintext | stricter |

`sslmode=disable | require | verify-full` in `DATABASE_URL` is now honoured, and `DATABASE_SSL=disable | require | verify-full` overrides everything. For a provider that signs with its own CA (Supabase, Amazon RDS), use `DATABASE_SSL=verify-full` with `DATABASE_SSL_CA` set to that CA (PEM text, or a file path).

Production is on Neon, so after this deploy the database certificate is verified. Neon's certificates are issued by a public CA and Node trusts it out of the box, so this needs no configuration. It could not be tried against Neon from the build environment, so do one of these:
- *Check first (30 seconds):* `openssl s_client -starttls postgres -connect <your-neon-host>:5432 -servername <your-neon-host> -verify_return_error </dev/null 2>&1 | grep "Verify return code"` must print `0 (ok)`.
- *Or deploy with a safety net:* add `DATABASE_SSL=require` in Render before deploying (the old code ignores it). The new code then encrypts without checking the certificate - already better than before. When convenient, remove the variable; the service restarts with verification on. If `/health` then reports the database as unavailable and the log says `[api] could not start` or `health check: database unavailable` with a certificate error, put the variable back and tell me.

**2. The server refuses to start in production on a published or short secret.** Only two variables can do this: `JWT_SECRET` and `ENCRYPTION_KEY`, when one is a value printed in `.env.example` / these docs, is left as an unexpanded `$(openssl ...)`, or is shorter than 16 characters. `render.yaml` generates both, so a Blueprint deploy is not affected. If you ever set either by hand, check its length in Render before deploying. To replace a weak `ENCRYPTION_KEY`, put the new value in `ENCRYPTION_KEY` and the old one in `ENCRYPTION_KEYS_OLD`, or saved sender and CRM credentials become unreadable.

Every other credential never stops a start. If `ADMIN_PASSWORD`, `ADMIN_API_TOKEN`, `INTERNAL_TOKEN`, `STRIPE_WEBHOOK_SECRET` or `RESEND_WEBHOOK_SECRET` is a well-known placeholder (`changeme`, `password`, an example from the docs), the one thing it guards is switched off - the admin login says it is not configured, the webhook is refused - and the log has a line starting `[env] SECURITY:` saying which and why. `ADMIN_JWT_SECRET` in that state is ignored and the admin session is signed with `JWT_SECRET`.

**3. Restarts no longer drop work.** On a deploy or restart (SIGTERM) the server stops accepting connections, lets requests already in progress finish, lets running jobs finish, and waits for both for up to 25 seconds (`SHUTDOWN_GRACE_MS`). A job still running after that is handed back to the queue, so the next process picks it up immediately instead of 15 minutes later. Render allows 30 seconds before it kills the process; if you raise `SHUTDOWN_GRACE_MS`, raise the service's shutdown delay with it. The log shows one line: `[api] stopped in ... ms (requests finished: yes, jobs finished: yes)`.

Other changes, none of which need action:
- **`/health`** still answers `{"ok":false,"db":"down",...}` with 503 when the database is unreachable, but the `error` field is now the fixed text `database unavailable`. The real reason (host, port, role) is in the log only.
- **Server timeouts** suit a server behind a proxy: idle connections are kept for 75 s (was 5 s, shorter than the proxy's own timeout, which is how a visitor gets an occasional 502), a request may take 2 minutes to arrive (was 5), headers 30 s. Overridable: `HTTP_KEEPALIVE_TIMEOUT_MS`, `HTTP_REQUEST_TIMEOUT_MS`, `HTTP_HEADERS_TIMEOUT_MS`.
- **Every API response** under `/v1/` and `/internal/` now carries `Cache-Control: no-store` unless the route set its own.
- **`CORS_ALLOW_REGEX`** is matched against the whole origin. A pattern written without `^` and `$` used to match any origin that merely contained it; it now has to match all of it, and the log says so once at start. The default (unset: any `https://*.vercel.app`, for Vercel previews) is unchanged; `none` allows only `APP_URL`, `CORS_EXTRA_ORIGINS` and localhost.
- **Logs** no longer print raw error objects at start-up, on an unhandled rejection or from a failed migration: one line with the error class, code and a redacted message.
- **MCP server:** nobody is told to run the MCP server with `npx` from a package name any more. The `@prospex` npm scope is not ours, so the name could be published by someone else and would run with the reader's API key. The server is run from this repository (README, "MCP for Claude / Cursor"). The root `.npmrc` points the scope at a registry that does not exist, so a stray install fails instead of fetching a stranger's package.
- **Node** is pinned to 22.x (`engines` in `package.json`, `node:22-alpine` in the Dockerfile, Node 22 in CI).
- **Docker:** the image now runs as the unprivileged `node` user, without dev dependencies, and `.dockerignore` keeps `.env` files, `.git`, `node_modules` and archives out of the build. The old Dockerfile did not copy `tsconfig.base.json`, so its build step could not succeed; that is fixed. `docker-compose.yml` publishes the database on `127.0.0.1` only and takes its password from `POSTGRES_PASSWORD` in `.env` (default unchanged for local development).
- **`npm run db:seed`** refuses to run with `NODE_ENV=production` (it creates an owner with a password printed in the README). `--force` overrides.
- **Optional `MIGRATION_DATABASE_URL`:** migrations can run as a role that owns the schema while `DATABASE_URL` uses a role that can only read and write rows. Unset, nothing changes. If you set it, give the application role its rights once, as the owner: `GRANT USAGE ON SCHEMA public TO <app role>; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO <app role>; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO <app role>; ALTER DEFAULT PRIVILEGES FOR ROLE <owner role> IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO <app role>; ALTER DEFAULT PRIVILEGES FOR ROLE <owner role> IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO <app role>;` - and try it on a copy of the database first.
- **CI** now runs the API test suite against a Postgres service and `npm audit` for production dependencies, with read-only workflow permissions.

**If the API runs serverless (Option 2, Vercel):** the start-up checks above apply there too, and the job runner endpoint stays shut until `INTERNAL_TOKEN` is set. Three things differ from a long-running server and are worth setting deliberately: each instance opens its own database connections (set `DB_POOL_MAX=2`), request rate limits are counted per instance rather than platform-wide, and migrations do not run on start (run `npm run db:migrate` before each deploy).

**What to watch in the logs.** There is no alerting built in, so point whatever monitor you use at these: `/health` answering 503; any line starting `[env] SECURITY:` (a credential was switched off at start); `[api] unhandled` (a request failed in a way nothing anticipated); `[shutdown]` followed by `returned to the queue` on every deploy (a job that regularly outlives the grace period).

**A time limit on database statements** is not set by the server, on purpose: as a connection start-up parameter it is refused or leaked by connection poolers (Neon's pooled URL included). The safe place is the database role - run once, as the owner: `ALTER ROLE <app role> SET statement_timeout = '60s'; ALTER ROLE <app role> SET idle_in_transaction_session_timeout = '60s';`. Migrations lift the limit for their own transaction. Optional; decide the number with the longest report or export you expect in mind.

**Rolling back:** nothing in B10 changes stored data. The whole picture - what a rollback costs, the restore script, and the order to do it in - is in B11.

---

### B11. Before you deploy, the four switches, and rolling back

This section replaces the scattered rollback notes above with one procedure. It is written from a rehearsal: the release that is live today and this one were both built, run against the same database, upgraded, used, rolled back and rolled forward again. Where a sentence says "works" or "fails", that is what happened.

The rule this release follows: **a one-click rollback stays cheap.** Whatever the new release would do by itself to data that already exists, in a form the previous release cannot read, is switched off unless you turn it on.

#### Before you deploy (10 minutes)

1. **Make a restore point.** In Neon: Branches > Create branch from the current state of `main` (instant, free; name it with today's date). That branch is your "undo everything", including the things no rollback can undo (below). On another database, take a backup.
2. **Check two secrets in Render** (Environment): `JWT_SECRET` and `ENCRYPTION_KEY` are each at least 16 characters and not an example value. The Blueprint generates both, so normally there is nothing to do. The new release refuses to start otherwise (B10).
3. **Check the admin password** is not a well-known example (`changeme`, `password`, a value from these docs). If it is, the service starts, but the admin sign-in page says it is switched off until you set a real one.
4. **Check the database certificate** (B10): `openssl s_client -starttls postgres -connect <your-neon-host>:5432 -servername <your-neon-host> -verify_return_error </dev/null 2>&1 | grep "Verify return code"` prints `0 (ok)`. Safety net if you would rather not check: set `DATABASE_SSL=require` in Render before deploying (the old code ignores it), and remove it once the service is up. If the new release cannot verify the certificate it says so in one log line starting `[db]`, with the setting to change.
5. **Decide the four switches** below. The defaults are the cheap-rollback choice; leave them unless you have a reason.

#### Deploy order

1. **API first.** It applies migrations 0015 to 0020 on start (all additive: the old release keeps running on the upgraded database). Wait for `curl https://<api>/health` to answer `{"ok":true,"db":"up"}`.
2. **Web second**, straight after. In between, the old web app works against the new API. The other way round does not: the new web app asks the old API for pages it does not have (it answers 404 for the workspace privacy settings, the deletion status and the audit log).
3. Sign in to `/admin` once and open one client report link to see both work.

#### The four switches

None of these is set in `render.yaml`. Add one in Render's Environment only if you want the non-default behaviour. `CREDENTIAL_REBIND_ON_READ` and `LINK_TOKENS_CLEAR_PLAINTEXT` are on only when the value is exactly `true`; anything else (unset, `1`, `yes`, `on`) is off.

A report link from before the upgrade keeps its readable copy by default, and the encrypted copy stored next to it is marked `legacy:`. A link that is replaced or turned off while the previous release is running stays replaced or off after you roll forward again - the old link does not come back.

| Variable | Default | What it does | What turning it on costs on a rollback |
|---|---|---|---|
| `CREDENTIAL_REBIND_ON_READ` | off | `true`: a saved sender, integration or webhook credential in the old format is rewritten, the first time it is read, in the new format that ties it to its workspace. Credentials saved or changed on the new release are always written in the new format. | Every credential that was read since is unreadable by the old release until the restore script has run. |
| `LINK_TOKENS_CLEAR_PLAINTEXT` | off | Client report links that existed before the upgrade get a hash and an encrypted copy on start either way (the new release looks links up by hash). `true` also removes the readable copy from the database. Links created or rotated on the new release never have a readable copy. | Every report link answers "not found" on the old release until the restore script has run. |
| `PRIVACY_SWEEP` | on | The daily clean-up removes the content of messages and activity belonging to leads that were deleted before this release (the new release removes it at the moment a lead is deleted; this catches up on the past). `off` skips only that; the rest of the retention clean-up still runs. | It deletes, so it cannot be rolled back at all - only the restore point brings that content back. If you want to decide later, set `off` before deploying. |
| `IP_LOOKUP_ALLOW_PLAIN_HTTP` | off | Website-visitor identification now asks only providers that answer over HTTPS. `true` adds the old provider that only answers over plain HTTP back as the last one tried. | None. |

**Visitor identification capacity:** with the plain-HTTP provider off, the free HTTPS provider allows about 1,000 look-ups a day. Set `IPINFO_TOKEN` (ipinfo.io, free for 50,000 a month) for more. Without it, visits beyond the free allowance are recorded and simply not matched to a company.

#### Tuning switches (none needs setting)

These have sensible defaults and are not in `render.yaml`. Add one in Render's Environment only to change a default. None of them touches stored data, so none of them matters for a rollback (the previous release ignores the ones it does not know).

| Variable | Default | What it does |
|---|---|---|
| `PASSWORD_HASH_CONCURRENCY` | 2 | How many password checks run at once (1 to 32). Each runs on its own worker thread, so sign-ins no longer slow other requests down. More sign-ins than this wait their turn for up to 30 seconds; with more than 200 waiting, the next one is told the service is busy (503) and can retry. Raise it only on an instance with more CPU cores than the default plan. If a worker thread cannot start, the server logs one line starting `[auth]` and checks passwords on the main thread as before - sign-in keeps working. |
| `LIST_QUERY_TIMEOUT_MS` | 8000 | The longest one list or search read may run before the user is told to narrow the search (503). Accepted range 250 to 60000; a value outside it is moved to the nearest end, and one log line starting `[config]` says so at start. |
| `ROW_CAP_<KIND>` | see below | The most of one kind of thing a workspace may hold. Past it, creating another is refused with a sentence naming the limit; existing ones are never removed. `<KIND>` is one of `LISTS` (2,000), `ICPS` (500), `SAVEDSEARCHES` (1,000), `AUTOPILOTS` (500), `MONITORS` (500), `SIGNALSUBSCRIPTIONS` (500), `TASKS` (100,000), `WEBHOOKS` (100), `APIKEYS` (100, active keys only), `CLIENTS` (5,000), `PIXELS` (200), `VISIBILITYPROMPTS` (1,000), `CAMPAIGNS` (5,000). A whole number, 1 or more. |
| `JOB_OPEN_TYPE_CAP` | 10000 | The most background jobs of one type a workspace may have waiting or running. Past it a request that would queue another is answered 429 with `Retry-After: 30` and saves nothing. |
| `JOB_OPEN_TOTAL_CAP` | 20000 | The same, across all job types of one workspace. |
| `DEBUG_SEARCH` | off | `true` (or `1`): the server log includes the text of web and people searches and the search providers' own error messages. Off, the log says only how long the search text was and which providers answered. Search text is what customers type (names, companies), so turn it on only while debugging and turn it off afterwards. |

The row and job limits are checked per server process: requests that arrive at the same moment are counted together within one process. With more than one API instance, a burst can exceed a limit by at most the number of instances times the requests each is handling at that instant; the next request sees the real count.

#### What a rollback costs

Rolling back means: redeploy the previous API build, then the previous web build. The database needs nothing undone. In the rehearsal, on the old release against the upgraded database:

**Worked with no action:** signing in (including a password that was reset on the new release), sessions issued before and after the upgrade, API keys created before and after, every page (leads, campaigns and their messages, senders, clients, webhooks, integrations, team, tasks, signals, visitors, usage, analytics), sending, and the visitor pixel. The old release starts normally and ignores the tables and columns it does not know.

**With the default switches, these need the restore script** (one command, below), and only if they exist:
- client report links **created or rotated on the new release** (the old release answered "not found" for them; after the script, it served them);
- sender and integration credentials **saved or changed on the new release** (the old release cannot read them; after the script it can).

Report links and credentials that existed before the upgrade and were not changed keep working on the old release with no script.

**With a switch turned on:** `LINK_TOKENS_CLEAR_PLAINTEXT=true` makes that every report link (in the rehearsal all three, two of them from before the upgrade, answered "not found" until the script ran); `CREDENTIAL_REBIND_ON_READ=true` makes that every credential that has been used. The same script fixes both.

**The script does not fix these - handle them by hand if you stay on the old release for more than a moment:**
- **Invitations sent from the new release** are refused by the old one. Send them again after rolling back.
- **Read-only API keys act as full-access keys.** Revoke them first: `UPDATE api_keys SET revoked_at = now() WHERE NOT ('*' = ANY(scopes)) AND revoked_at IS NULL;`
- **Two-factor sign-in is not asked for** (accounts and the admin console sign in with the password alone; the settings are kept for when you roll forward). Email confirmation is not enforced; security emails are not sent.
- **The platform-wide do-not-contact list, "erase a person" and the workspace AI switch are unknown to the old release.** It would email an address that is only on the platform list. If you have used that list, copy it into every workspace's own list before rolling back: `INSERT INTO suppressions (org_id, email, reason) SELECT o.id, g.email, 'platform' FROM organizations o CROSS JOIN global_suppressions g ON CONFLICT DO NOTHING;`
- **Webhooks created or rotated on the new release** are not signed correctly by the old one, and the daily job-change scan records nothing on it (B8).

**No rollback undoes these - only the restore point does:** leads, workspaces and people erased on the new release; the content removed by `PRIVACY_SWEEP`; and what the retention clean-up deleted on its daily run (old visitor page views, sign-in attempts, finished jobs, activity older than 90 days - the periods are in the Privacy Policy).

#### The restore script

`scripts/rollback-restore.mjs` writes report-link tokens back in readable form and rewrites new-format sender and integration credentials in the old format, under the same key. It removes nothing: the new columns stay, so rolling forward again needs no step at all (rehearsed: the new release started and served every link). It prints counts only - never a token, a credential or a connection string - and is safe to run twice.

Run it with the **new** build and the **production** values, **before** redeploying the previous build. From a clean checkout of the new release on your own machine (a `.env` file in the checkout would be read for anything you do not set, so use a clean one):

```bash
npm ci && npm run build -w packages/core -w packages/db -w apps/api
export DATABASE_URL='<the production value>' ENCRYPTION_KEY='<the production value>' JWT_SECRET='<the production value>'
# export ENCRYPTION_KEYS_OLD='...'   # only if it is set in production
node scripts/rollback-restore.mjs --dry-run     # counts what it would change
node scripts/rollback-restore.mjs               # does it
```

If the dry run reports nothing to change, there is nothing to restore: redeploy the previous build straight away. A line `could not be read` means those rows were saved under a key that is not in `ENCRYPTION_KEY` / `ENCRYPTION_KEYS_OLD`; they are left untouched.

**Rollback order:** (1) the script, (2) the hand steps above that apply to you, (3) redeploy the previous API build, (4) redeploy the previous web build. **Rolling forward again:** deploy the new API, then the new web. Nothing else.

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
